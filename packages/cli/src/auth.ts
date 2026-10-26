import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as http from "http";
import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { requireServerConfig, type ServerConfig } from "./server";

const CREDENTIALS_DIR = path.join(os.homedir(), ".ophan");
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "credentials.json");

export interface Credentials {
  access_token: string;
  refresh_token: string;
  user_id: string;
  email: string;
  expires_at: number;
}

export function readCredentials(): Credentials | null {
  try {
    const data = fs.readFileSync(CREDENTIALS_FILE, "utf8");
    return JSON.parse(data) as Credentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), "utf8");
}

export function deleteCredentials(): void {
  try {
    fs.unlinkSync(CREDENTIALS_FILE);
  } catch {
    // Already gone
  }
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        return reject(new Error("Could not find available port"));
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/**
 * Quick connectivity pre-check. Fails fast (3s timeout) instead of letting
 * the Supabase GoTrue client retry ~15 times with full stack traces.
 */
async function checkSupabaseReachable(url: string, timeoutMs = 3000): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${url}/auth/v1/health`, { signal: controller.signal });
  } catch {
    throw new Error(`Cannot reach Supabase at ${url}. Check your connection and that your Ophan server is running.`);
  } finally {
    clearTimeout(timer);
  }
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><title>Ophan CLI</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; display: flex;
    justify-content: center; align-items: center; min-height: 100vh;
    margin: 0; background: #0a0a0a; color: #fafafa; }
  .card { text-align: center; padding: 3rem; }
  h1 { color: #2dd4bf; margin-bottom: 0.5rem; }
  p { color: #a3a3a3; }
</style>
</head>
<body>
  <div class="card">
    <h1>Logged in!</h1>
    <p>You can close this tab and return to your terminal.</p>
  </div>
</body>
</html>`;

/**
 * Browser-based login flow.
 * 1. Start local HTTP server
 * 2. Open browser to webapp /auth/cli?port=PORT
 * 3. Wait for callback with token_hash
 * 4. Exchange token_hash for session using the server's Supabase config
 * 5. Store session credentials and return
 */
export async function login(
  server: ServerConfig,
  timeoutMs: number = 120_000
): Promise<Credentials> {
  if (!server.serverUrl) {
    throw new Error("Browser login needs a server URL. Run `npx @ophan/cli login --server <url>`.");
  }
  const webappUrl = server.serverUrl;
  const { supabaseUrl, supabaseAnonKey } = server;

  const port = await findAvailablePort();

  return new Promise<Credentials>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(
        new Error("Login timed out. Please try again with `npx @ophan/cli login`.")
      );
    }, timeoutMs);

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404, { Connection: "close" });
        res.end("Not found");
        return;
      }

      const tokenHash = url.searchParams.get("token_hash");

      if (!tokenHash) {
        res.writeHead(400, { Connection: "close" });
        res.end("Missing required parameters");
        return;
      }

      // Exchange token_hash for an independent session via verifyOtp,
      // against the server's Supabase (from /api/config or env, see server.ts).
      const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });

      const { data, error: otpError } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: "magiclink",
      });

      if (otpError || !data.session) {
        const msg = otpError?.message || "No session returned";
        res.writeHead(400, {
          "Content-Type": "text/html",
          Connection: "close",
        });
        res.end(
          `<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a;color:#fafafa"><div style="text-align:center"><h1 style="color:#ef4444">Login failed</h1><p style="color:#a3a3a3">${msg}</p></div></body></html>`
        );
        clearTimeout(timeout);
        server.closeAllConnections();
        server.close(() => reject(new Error(msg)));
        return;
      }

      const creds: Credentials = {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        user_id: data.session.user.id,
        email: data.session.user.email || "",
        expires_at: data.session.expires_at || 0,
      };

      saveCredentials(creds);

      // Connection: close tells browser to not keep-alive, so server.close() resolves immediately
      res.writeHead(200, { "Content-Type": "text/html", Connection: "close" });
      res.end(SUCCESS_HTML);

      clearTimeout(timeout);
      server.closeAllConnections();
      server.close(() => resolve(creds));
    });

    server.listen(port, async () => {
      const authUrl = `${webappUrl}/auth/cli?port=${port}`;
      console.log(`\n  Opening browser to sign in...`);
      console.log(`  If it doesn't open, visit: ${authUrl}\n`);

      try {
        const open = (await import("open")).default;
        await open(authUrl);
      } catch {
        // Browser open failed -- user can still visit the URL manually
      }
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Get an authenticated Supabase client from stored credentials.
 * The Supabase config comes from the configured server (see server.ts), not from credentials.
 * Throws NoServerConfiguredError when no server is configured.
 * Only refreshes tokens when they're actually expired -- avoids consuming
 * the refresh token unnecessarily (which would invalidate it via rotation).
 */
export async function getAuthenticatedClient(server?: ServerConfig): Promise<{
  supabase: SupabaseClient;
  userId: string;
}> {
  const { supabaseUrl, supabaseAnonKey } = server ?? (await requireServerConfig());

  const creds = readCredentials();
  if (!creds) {
    throw new Error("Not logged in. Run `npx @ophan/cli login` first.");
  }

  // Fail fast if Supabase is unreachable -- prevents ~15 noisy retry stack traces
  // from the GoTrue client's internal retry logic.
  await checkSupabaseReachable(supabaseUrl);

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  const now = Math.floor(Date.now() / 1000);
  const BUFFER_SECONDS = 60;

  if (creds.expires_at && creds.expires_at > now + BUFFER_SECONDS) {
    // Access token still valid -- set session without triggering refresh.
    // This does NOT consume the refresh token.
    const { error } = await supabase.auth.setSession({
      access_token: creds.access_token,
      refresh_token: creds.refresh_token,
    });

    if (!error) {
      return { supabase, userId: creds.user_id };
    }
    // If setSession failed despite token appearing valid (e.g., revoked server-side),
    // fall through to refresh attempt below.
  }

  // Access token expired (or missing expires_at) -- explicitly refresh
  const { data, error } = await supabase.auth.refreshSession({
    refresh_token: creds.refresh_token,
  });

  if (error || !data.session) {
    throw new Error(
      `Session expired or invalid. Run \`npx @ophan/cli login\` again.\n  ${error?.message || "No session returned"}`
    );
  }

  // Persist the new tokens so next invocation can use the fresh access_token
  // without consuming the refresh token again
  const updated: Credentials = {
    ...creds,
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at || 0,
  };
  saveCredentials(updated);

  return { supabase, userId: creds.user_id };
}
