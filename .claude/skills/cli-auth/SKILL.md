---
name: cli-auth
description: CLI authentication and self-hosted server config (server.ts, /api/config, magic link tokens). Use when working on login/logout, server resolution, token refresh, credential storage, or the CLI↔webapp auth handoff.
---

# CLI Authentication System

## Overview

The CLI authenticates via a browser-based magic link flow that gives the CLI its own **independent token chain** separate from the browser session. This prevents refresh token rotation conflicts between browser and CLI.

## Server Config (Runtime, Self-Hosted)

Nothing is baked in at build time. `packages/cli/src/server.ts` resolves which server to use:

```
1. OPHAN_SUPABASE_URL + OPHAN_SUPABASE_ANON_KEY env      → used directly (CI, no webapp needed)
2. --server flag, else OPHAN_SERVER_URL env (set by the extension from `ophan.serverUrl`),
   else the server saved in ~/.ophan/config.json by `ophan login --server`
     → Supabase settings from ~/.ophan/config.json if saved for that URL,
       else GET <server>/api/config (webapp route packages/webapp/src/routes/api/config.ts)
3. nothing → resolveServerConfig() returns null; requireServerConfig() throws NoServerConfiguredError
```

- `~/.ophan/config.json` = `{ serverUrl, supabaseUrl, supabaseAnonKey }` (all public values).
- Switching servers on `login` deletes `credentials.json`: credentials belong to one server.
- No server never breaks analysis: `createPullFn` returns undefined, `watch --sync` warns and continues.

## Login Flow

```
User runs: npx @ophan/cli login --server https://ophan.example.com
  │
  ├─ requireServerConfig() → saveServer() to ~/.ophan/config.json
  │
  ├─ findAvailablePort() → localhost:PORT
  ├─ Start HTTP server on :PORT (listening for /callback)
  ├─ open() → browser to {webappUrl}/auth/cli?port=PORT
  │
  └─ Browser:
     ├─ User signs in (email/password)
     ├─ signInWithPassword() → normal Supabase auth
     ├─ generateCliToken() (server function, uses admin API):
     │  └─ serviceClient.auth.admin.generateLink({ type: 'magiclink', email })
     │     └─ Returns { hashed_token: 'abc...' }
     │
     ├─ Redirect to: http://localhost:PORT/callback?token_hash=abc...
     │
     └─ CLI /callback handler:
        ├─ Create Supabase client from the resolved server config
        ├─ supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })
        │  └─ Returns independent session: { access_token, refresh_token, user }
        ├─ saveCredentials() → ~/.ophan/credentials.json
        └─ Show success HTML page, resolve promise
```

**Timeout:** 120 seconds (configurable).

## Why Separate Token Chains

1. **Browser** gets access + refresh tokens from normal login
2. **CLI** gets a **separate** access + refresh token via `admin.generateLink()` + `verifyOtp()`
3. These are independent sessions tied to the same user
4. **No refresh token rotation conflicts** -- Supabase rotates refresh tokens on use; separate chains prevent browser and CLI from invalidating each other
5. **Independent lifetimes** -- each can refresh independently

## Credential Storage

**File:** `~/.ophan/credentials.json`

```typescript
interface Credentials {
  access_token: string;
  refresh_token: string;
  user_id: string;           // UUID
  email: string;
  expires_at: number;        // Unix timestamp (seconds)
}
```

**No api_url or api_key** -- those come from the resolved server config (see above), not from stored credentials.

Functions: `readCredentials()`, `saveCredentials()`, `deleteCredentials()`

## Token Refresh Logic (`getAuthenticatedClient()`)

Smart refresh that minimizes refresh token consumption:

```
1. Read credentials from ~/.ophan/credentials.json
2. checkSupabaseReachable() → single fetch with 3s timeout
   Fails fast with clean error instead of 15+ GoTrue retry stack traces
3. Check: expires_at > now + 60 seconds?
   ├─ YES (still valid):
   │  └─ supabase.auth.setSession(access_token, refresh_token)
   │     Does NOT consume refresh token (no rotation happens)
   │
   └─ NO (expired or about to expire):
      └─ supabase.auth.refreshSession(refresh_token)
         → Get new access_token + refresh_token
         → Save updated tokens to disk
         → New tokens used for this + future invocations
```

**60-second buffer:** Prevents race conditions where token expires between check and API call.

**Key optimization:** `setSession()` when token is still valid avoids consuming the refresh token. This matters because Supabase rotates refresh tokens on use -- unnecessary refreshes create new tokens and invalidate old ones.

**Connectivity pre-check:** `checkSupabaseReachable()` does a single fetch to `/auth/v1/health` with a 3-second timeout. If Supabase is unreachable, it throws immediately with a clean error message. This prevents the Supabase GoTrue client from retrying ~15 times internally, each producing a `TypeError: fetch failed` stack trace.

## Multi-Account Safety (in sync.ts)

```
On each sync:
  Read sync_meta.last_synced_user_id
  If different from current user:
    → Reset all synced_at to NULL (forces full re-push)
    → Clear function_gc table
    → Store new user_id
```

Prevents data leaking between accounts if the same repo is synced by different users.

## Silent Fallbacks

Auth failures **never block analysis**:
- `createPullFn()` catches all errors, returns `undefined` → analyze continues offline
- Watch mode: if session expired during watch, warns user but continues analyzing
- Sync failures logged but don't crash

## CLI Commands

- `npx @ophan/cli login [--server <url>]` -- Browser-based auth flow against a self-hosted server
- `npx @ophan/cli logout` -- Deletes `~/.ophan/credentials.json`

**Environment:** `OPHAN_SERVER_URL`, or `OPHAN_SUPABASE_URL` + `OPHAN_SUPABASE_ANON_KEY`. There is no default server.

## Webapp Side (Token Generation)

**File:** `packages/webapp/src/services/auth/cliAuth.ts`

```typescript
export const generateCliToken = createServerFn({ method: 'POST' })
  .middleware([authentication])    // User must be logged in via browser
  .handler(async ({ context }) => {
    const serviceClient = getSupabaseServiceRoleClient()  // Admin API
    const { data } = await serviceClient.auth.admin.generateLink({
      type: 'magiclink',
      email: context.user.email,
    })
    return { token_hash: data.properties?.hashed_token }
  })
```

**Why admin API?** Only the service role can generate magic link tokens. The user's own client can't do this. Server-side only, never exposed to client.

## Key Files

- `packages/cli/src/server.ts` -- Supabase URL and anon key (build-time injected)
- `packages/cli/src/auth.ts` -- Login flow, credential storage, token refresh, connectivity pre-check
- `packages/cli/src/index.ts` -- Login/logout commands, `createPullFn()`
- `packages/cli/esbuild.mjs` -- Build config with `define` for Supabase env vars
- `packages/webapp/src/services/auth/cliAuth.ts` -- Token generation server function
- `packages/webapp/src/routes/auth/cli.tsx` -- CLI auth page (browser side)
