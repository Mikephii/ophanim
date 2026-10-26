// Runtime configuration that is safe to expose to browsers and the CLI.
//
// Read from the server's environment when the process starts, never inlined at build
// time, so one Docker image works for every self-hosted server. The server renders it
// into the page as `window.__OPHAN_CONFIG__` and serves it at `/api/config` for
// `ophan login --server <url>`.

export interface PublicConfig {
  supabaseUrl: string
  supabaseAnonKey: string
}

declare global {
  interface Window {
    __OPHAN_CONFIG__?: PublicConfig
  }
}

type Env = Record<string, string | undefined>

/**
 * `SUPABASE_PUBLIC_URL` is the Supabase URL browsers and CLIs should use. It only needs
 * setting when the webapp reaches Supabase on a different address than clients do
 * (e.g. a Docker network name); otherwise `SUPABASE_URL` is used for both.
 */
export function readPublicConfigFromEnv(env: Env): PublicConfig {
  return {
    supabaseUrl: env.SUPABASE_PUBLIC_URL || env.SUPABASE_URL || '',
    supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
  }
}

/** Server: from the environment. Browser: from the script the server rendered. */
export function getPublicConfig(): PublicConfig {
  if (typeof window === 'undefined') return readPublicConfigFromEnv(process.env)
  return window.__OPHAN_CONFIG__ ?? { supabaseUrl: '', supabaseAnonKey: '' }
}

/**
 * The auth cookie name. Supabase derives it from the URL's hostname, so a server that reaches
 * Supabase on a different address than browsers do would otherwise write and read different
 * cookies. Both sides name it after the public URL.
 */
export function authCookieName(config: PublicConfig): string {
  let host = 'local'
  try {
    host = new URL(config.supabaseUrl).hostname.split('.')[0] || host
  } catch {
    // Unconfigured: any stable name will do
  }
  return `sb-${host}-auth-token`
}

/** Inline script body that defines `window.__OPHAN_CONFIG__`, safe inside a <script> tag. */
export function publicConfigScript(config: PublicConfig): string {
  return `window.__OPHAN_CONFIG__=${JSON.stringify(config).replace(/</g, '\\u003c')};`
}

/** Routes that must answer even before Supabase is configured, so operators can diagnose a server. */
const ALWAYS_AVAILABLE = ['/api/health', '/api/config']

/**
 * The server environment variables still missing, or [] when the webapp can talk to Supabase.
 * Without them every page fails, so requests get a clear 503 naming what to set instead.
 */
export function missingServerEnv(env: Env): string[] {
  return ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].filter((name) => !env[name])
}

export function isAlwaysAvailable(pathname: string): boolean {
  return ALWAYS_AVAILABLE.includes(pathname.replace(/\/+$/, ''))
}
