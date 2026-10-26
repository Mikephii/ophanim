// Self-hosted server settings: cloud sync and sign-in only exist when the user has
// pointed the extension at their own Ophan server (`ophan.serverUrl`). With no server,
// the extension is purely local and never prompts to sign in.

/** The configured server URL, or "" when none is set or the value is not an http(s) URL. */
export function parseServerUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : "";
  } catch {
    return "";
  }
}

/** Environment for the spawned CLI. The child's env is frozen at spawn, so settings changes need a restart. */
export function buildCliEnv(
  base: NodeJS.ProcessEnv,
  settings: { apiKey: string; serverUrl: string }
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ANTHROPIC_API_KEY: settings.apiKey };
  if (settings.serverUrl) env.OPHAN_SERVER_URL = settings.serverUrl;
  else delete env.OPHAN_SERVER_URL;
  return env;
}

export function shouldSync(autoSync: boolean, serverUrl: string): boolean {
  return autoSync && serverUrl !== "";
}

export function shouldPromptSignIn(state: { serverUrl: string; dismissed: boolean; hasCredentials: boolean }): boolean {
  return state.serverUrl !== "" && !state.dismissed && !state.hasCredentials;
}

/** Terminal command for signing in, or null when no server is configured. */
export function signInCommand(serverUrl: string): string | null {
  if (!serverUrl) return null;
  // parseServerUrl only lets through http(s) URLs; quote anyway for the shell.
  return `npx @ophan/cli login --server '${serverUrl.replace(/'/g, "'\\''")}'`;
}
