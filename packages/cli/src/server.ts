// Which Ophan server (if any) this CLI talks to.
//
// Nothing is baked in at build time: Ophan is self-hosted, and local analysis needs no
// server at all. Resolution order:
//   1. OPHAN_SUPABASE_URL + OPHAN_SUPABASE_ANON_KEY env vars (CI, or skipping the webapp)
//   2. An explicit server URL: --server flag, else OPHAN_SERVER_URL (the extension sets this),
//      else the one saved by `ophan login --server`. Its Supabase settings come from
//      ~/.ophan/config.json when saved for that URL, otherwise from GET <server>/api/config.
//   3. Nothing: login/sync fail with NoServerConfiguredError, analysis is unaffected.
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export const SELF_HOSTING_DOCS = "https://github.com/Mikephii/ophanim/blob/main/docs/self-hosting.md";

export interface ServerConfig {
  /** The webapp URL ("" when configured by Supabase env vars alone). */
  serverUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export class NoServerConfiguredError extends Error {
  constructor() {
    super(`No Ophan server configured. Run \`npx @ophan/cli login --server <url>\`, or see ${SELF_HOSTING_DOCS}`);
    this.name = "NoServerConfiguredError";
  }
}

export const DEFAULT_CONFIG_FILE = path.join(os.homedir(), ".ophan", "config.json");

export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function readSavedServer(file = DEFAULT_CONFIG_FILE): ServerConfig | null {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof data.serverUrl === "string" && typeof data.supabaseUrl === "string" && typeof data.supabaseAnonKey === "string") {
      return { serverUrl: data.serverUrl, supabaseUrl: data.supabaseUrl, supabaseAnonKey: data.supabaseAnonKey };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveServer(config: ServerConfig, file = DEFAULT_CONFIG_FILE): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** Asks an Ophan webapp for its public Supabase settings. */
export async function fetchServerConfig(serverUrl: string, fetchFn: FetchLike = fetch, timeoutMs = 5000): Promise<ServerConfig> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchFn(`${serverUrl}/api/config`, { signal: controller.signal });
  } catch {
    throw new Error(`Cannot reach the Ophan server at ${serverUrl}. Check the URL and that the server is running.`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`${serverUrl}/api/config returned ${res.status}. Is this an Ophan server? See ${SELF_HOSTING_DOCS}`);
  }
  const body = await res.json();
  if (typeof body?.supabaseUrl !== "string" || typeof body?.supabaseAnonKey !== "string" || !body.supabaseUrl || !body.supabaseAnonKey) {
    throw new Error(`${serverUrl}/api/config did not return Supabase settings. See ${SELF_HOSTING_DOCS}`);
  }
  return { serverUrl, supabaseUrl: body.supabaseUrl, supabaseAnonKey: body.supabaseAnonKey };
}

export interface ResolveOptions {
  /** --server flag value, if given. */
  server?: string;
  env?: NodeJS.ProcessEnv;
  saved?: ServerConfig | null;
  fetchFn?: FetchLike;
}

/** The server to use, or null when none is configured. */
export async function resolveServerConfig(options: ResolveOptions = {}): Promise<ServerConfig | null> {
  const env = options.env ?? process.env;
  const saved = options.saved === undefined ? readSavedServer() : options.saved;

  if (env.OPHAN_SUPABASE_URL && env.OPHAN_SUPABASE_ANON_KEY) {
    return {
      serverUrl: env.OPHAN_SERVER_URL ? normalizeServerUrl(env.OPHAN_SERVER_URL) : "",
      supabaseUrl: env.OPHAN_SUPABASE_URL,
      supabaseAnonKey: env.OPHAN_SUPABASE_ANON_KEY,
    };
  }

  const explicit = options.server || env.OPHAN_SERVER_URL;
  if (!explicit) return saved;

  const serverUrl = normalizeServerUrl(explicit);
  if (saved && saved.serverUrl === serverUrl) return saved;
  return fetchServerConfig(serverUrl, options.fetchFn);
}

/** Like resolveServerConfig, but throws NoServerConfiguredError instead of returning null. */
export async function requireServerConfig(options: ResolveOptions = {}): Promise<ServerConfig> {
  const config = await resolveServerConfig(options);
  if (!config) throw new NoServerConfiguredError();
  return config;
}
