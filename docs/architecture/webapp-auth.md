# Supabase SSR Auth for TanStack Start: Complete Implementation Guide

This document explains how to implement secure, performant Supabase authentication in a TanStack Start (React) application with SSR, server functions, API routes, and OAuth. It covers every layer: middleware, cookie handling, route protection, session caching, and known pitfalls.

**Stack**: TanStack Start (v1.139+), `@supabase/ssr` (v0.7+), `@supabase/supabase-js` (v2.47+), `@tanstack/react-query` (v5+), Nitro server runtime.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Environment Variables](#2-environment-variables)
3. [Web Utilities Wrapper](#3-web-utilities-wrapper)
4. [Supabase Client Creation](#4-supabase-client-creation)
   - [Server Client (SSR + Server Functions)](#41-server-client-via-middleware)
   - [Browser Client](#42-browser-client)
   - [Service Role Client (Admin)](#43-service-role-client-admin-only)
5. [Global Request Middleware (supabaseMW)](#5-global-request-middleware-supabasemw)
6. [Authentication Middleware for Server Functions](#6-authentication-middleware-for-server-functions)
7. [Registering Global Middleware](#7-registering-global-middleware)
8. [Session Retrieval -- The Isomorphic Pattern](#8-session-retrieval-the-isomorphic-pattern)
9. [Route Protection with beforeLoad](#9-route-protection-with-beforeload)
10. [Server Functions -- Auth & Unauth Patterns](#10-server-functions-auth--unauth-patterns)
11. [Auth Server Functions (Sign In, Sign Up, Sign Out)](#11-auth-server-functions)
12. [OAuth Callback Route (Google)](#12-oauth-callback-route-google)
13. [Magic Link / OTP Callback Route](#13-magic-link--otp-callback-route)
14. [React Query Caching -- Avoiding Redundant Supabase Calls](#14-react-query-caching-avoiding-redundant-supabase-calls)
15. [Router Setup](#15-router-setup)
16. [The Chunked Cookie Problem](#16-the-chunked-cookie-problem)
17. [getSession() vs getUser() -- Security Implications](#17-getsession-vs-getuser-security-implications)
18. [Common Pitfalls & Gotchas](#18-common-pitfalls--gotchas)
19. [File Structure Summary](#19-file-structure-summary)
20. [Complete Flow Diagrams](#20-complete-flow-diagrams)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         BROWSER                                  │
│                                                                  │
│  browserClient (createBrowserClient from @supabase/ssr)         │
│  ├── getSession() -- reads from memory/cookies, no server call   │
│  └── Used for Realtime, client-side session checks              │
│                                                                  │
│  React Query Cache (5 min stale time)                           │
│  └── Caches user data fetched via server functions              │
└─────────────────────┬───────────────────────────────────────────┘
                      │ HTTP Request (SSR / Server Function)
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                         SERVER                                   │
│                                                                  │
│  Global Middleware: supabaseMW (runs on EVERY request)          │
│  ├── Validates chunked cookies (detects corruption)             │
│  ├── Creates server Supabase client (createServerClient)        │
│  └── Adds SBServerClient to request context                    │
│                                                                  │
│  Function Middleware: authentication (opt-in per server fn)     │
│  ├── Calls supabase.auth.getUser() to validate JWT             │
│  ├── Redirects to /signin if no user                           │
│  └── Adds user to context                                      │
│                                                                  │
│  Server Functions: Use context.SBServerClient directly          │
│  API Routes: Use context.SBServerClient directly                │
└─────────────────────────────────────────────────────────────────┘
```

**Key design decisions:**

- `supabaseMW` runs globally on every request so that `context.SBServerClient` is always available -- even for unauthenticated routes and server functions.
- `authentication` middleware is opt-in. Server functions that need a verified user chain it via `.middleware([authentication])`. Auth functions like `signInWithPassword` do NOT use it (you can't require auth to log in).
- Route-level protection uses `beforeLoad` hooks in layout routes, not middleware.
- Session tokens live in cookies. The browser client reads them automatically. The server client reads them via the middleware cookie bridge.
- User data is cached with React Query so navigating between protected routes doesn't re-call `supabase.auth.getUser()` on every navigation.

---

## 2. Environment Variables

All read at runtime by the server process; nothing is inlined at build time, so one image serves any self-hosted server.

```bash
SUPABASE_URL=https://your-project.supabase.co   # how the webapp server reaches Supabase
SUPABASE_ANON_KEY=eyJ...                         # public anon key
SUPABASE_SERVICE_ROLE_KEY=eyJ...                 # admin key, server only, NEVER exposed to clients
SUPABASE_PUBLIC_URL=https://supabase.example.com # optional: the URL browsers and CLIs use, if different
```

**How the browser gets its config:** `src/utils/public-config.ts` builds `{ supabaseUrl, supabaseAnonKey }` from the environment (`SUPABASE_PUBLIC_URL` falling back to `SUPABASE_URL`). The root document renders it as `window.__OPHAN_CONFIG__` in an inline script; on the client the same component reads that value back, so server and client render identical markup. `GET /api/config` (`src/routes/api/config.ts`) serves the same object to `ophan login --server`. The service role key never leaves the server.

---

## 3. Web Utilities Wrapper

TanStack Start provides server-only utilities for reading/writing cookies and headers. These come from `@tanstack/react-start/server` and internally use Nitro's `AsyncLocalStorage` to access the current request/response. You must wrap them with `createServerOnlyFn` to prevent them from being imported in client code.

```ts
// src/services/startWebUtils.ts
import { createServerOnlyFn } from '@tanstack/react-start'
import {
  getRequestHeader as getRequestHeaderTSS,
  getCookie as getCookieTSS,
  getCookies as getCookiesTSS,
  setCookie as setCookieTSS,
  deleteCookie as deleteCookieTSS,
  getResponseHeaders as getResponseHeadersTSS,
} from '@tanstack/react-start/server'

export const getRequestHeader = createServerOnlyFn((name: string) => {
  return getRequestHeaderTSS(name)
})

export const getCookie = createServerOnlyFn((name: string) => {
  return getCookieTSS(name)
})

export const getCookies = createServerOnlyFn(() => {
  return getCookiesTSS()
})

export const setCookie = createServerOnlyFn((name: string, value: string) => {
  return setCookieTSS(name, value)
})

export const deleteCookie = createServerOnlyFn((name: string) => {
  return deleteCookieTSS(name)
})

export const getResponseHeaders = createServerOnlyFn(() => {
  return getResponseHeadersTSS()
})
```

**Why?** If you import `@tanstack/react-start/server` directly in a file that also gets imported on the client, Vite will try to bundle server-only code into the client. `createServerOnlyFn` ensures tree-shaking removes these from the client bundle.

---

## 4. Supabase Client Creation

### 4.1 Server Client (via Middleware)

The server client is created inside middleware, NOT as a standalone utility function. This is because it needs access to the current request's cookies via TanStack's `AsyncLocalStorage` context (the `getCookies`/`setCookie` calls only work during an active request).

```ts
// src/middleware/supabaseClient.ts
import { createServerClient } from '@supabase/ssr'
import { createMiddleware } from '@tanstack/react-start'
import { getCookies, setCookie, deleteCookie } from '~/services/startWebUtils'

export const supabaseMW = createMiddleware().server(async ({ next }) => {
  // Cookie validation omitted here -- see Section 16 for the full version

  const client = createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
      cookies: {
        getAll() {
          return Object.entries(getCookies()).map(([name, value]) => ({
            name,
            value,
          }))
        },
        setAll(cookies) {
          cookies.forEach((cookie) => {
            try {
              setCookie(cookie.name, cookie.value)
            } catch (e) {
              // Swallow -- headers may already be sent during SSR streaming
            }
          })
        },
      },
    },
  )

  return next({
    context: {
      SBServerClient: client,
    },
  })
})
```

**Critical**: `persistSession: true` and `autoRefreshToken: true` tell `@supabase/ssr` to read tokens from cookies and automatically refresh expired access tokens by calling Supabase's token endpoint. When a token is refreshed, it writes the new tokens back via `setAll()`.

**Critical**: The `cookies.getAll()` and `cookies.setAll()` functions are the bridge between Supabase's auth system and TanStack Start's cookie handling. `@supabase/ssr` calls `getAll()` to read the current session from cookies and `setAll()` to persist new/refreshed tokens. Without this bridge, the server would have no way to know the user's session.

### 4.2 Browser Client

```ts
// src/utils/supabase/browserClient.ts
import { createBrowserClient } from '@supabase/ssr'
import { getPublicConfig } from '@/utils/public-config'

export function getSupabaseBrowserClient() {
  const { supabaseUrl, supabaseAnonKey } = getPublicConfig()

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase URL or Anon Key is not set')
  }
  return createBrowserClient(supabaseUrl, supabaseAnonKey)
}
```

The browser client from `@supabase/ssr` automatically reads/writes cookies in the browser. No custom cookie config needed. It handles:

- Reading the session from cookies set by the server
- Auto-refreshing tokens when they expire
- Writing refreshed tokens back to cookies

### 4.3 Service Role Client (Admin Only)

```ts
// src/utils/supabase/serviceRoleClient.ts
import { createClient } from '@supabase/supabase-js'
import { createServerOnlyFn } from '@tanstack/react-start'

// IMPORTANT: Service role client MUST use @supabase/supabase-js, NOT @supabase/ssr
// Using @supabase/ssr for service role results in incorrect privileges
// See: https://github.com/orgs/supabase/discussions/15860
export const getSupabaseServerServiceRoleClient = createServerOnlyFn(() => {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  )
})
```

**Key gotcha**: The service role client MUST use `createClient` from `@supabase/supabase-js`, NOT `createServerClient` from `@supabase/ssr`. Using `@supabase/ssr` for service role operations results in incorrect privileges because it tries to use the cookie-based session instead of the service role key. This is wrapped in `createServerOnlyFn` to guarantee it never ends up in the client bundle.

---

## 5. Global Request Middleware (supabaseMW)

The full middleware with cookie corruption detection:

```ts
// src/middleware/supabaseClient.ts
import { createServerClient } from '@supabase/ssr'
import { createMiddleware, json } from '@tanstack/react-start'
import { getCookies, setCookie, deleteCookie } from '~/services/startWebUtils'

export const supabaseMW = createMiddleware().server(async ({ next }) => {
  // https://github.com/supabase/ssr/issues/67
  const cookies = getCookies()
  const cookiesArr = Object.entries(cookies)

  // Strict UTF-8 decoder -- throws on bad bytes
  const strictDecoder = new TextDecoder('utf-8', { fatal: true })
  let hasCorruptedCookie = false

  const chunkedCookies = new Map<
    string,
    { name: string; value: string; index: number }[]
  >()

  const chunkedCookieRegex = /^(sb-[a-zA-Z0-9._-]+-auth-token)\.(\d+)$/
  const standaloneCookieRegex = /^sb-[a-zA-Z0-9._-]+-auth-token$/

  cookiesArr.forEach(([name, value]) => {
    const chunkMatch = name.match(chunkedCookieRegex)

    if (chunkMatch) {
      const baseName = chunkMatch[1]
      const index = parseInt(chunkMatch[2])

      if (!chunkedCookies.has(baseName)) {
        chunkedCookies.set(baseName, [])
      }
      chunkedCookies.get(baseName)!.push({ name, value: value || '', index })
    } else if (
      name.match(standaloneCookieRegex) &&
      value?.startsWith('base64-')
    ) {
      chunkedCookies.set(name, [{ name, value: value || '', index: 0 }])
    }
  })

  // Validate each cookie group
  chunkedCookies.forEach((chunks, baseName) => {
    chunks.sort((a, b) => a.index - b.index)
    const combinedValue = chunks.map((c) => c.value).join('')

    if (combinedValue.startsWith('base64-')) {
      try {
        const raw = combinedValue.slice(7) // Strip "base64-" prefix
        const buffer = Buffer.from(raw, 'base64')
        strictDecoder.decode(buffer)
      } catch (e) {
        console.error(`Corrupted Supabase session detected in ${baseName}`)
        chunks.forEach((chunk) => {
          deleteCookie(chunk.name)
          hasCorruptedCookie = true
        })
      }
    }
  })

  if (hasCorruptedCookie) {
    throw json({ status: 400, message: 'Bad Request - Corrupted Cookies' })
  }

  const client = createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
      cookies: {
        getAll() {
          return Object.entries(getCookies()).map(([name, value]) => ({
            name,
            value,
          }))
        },
        setAll(cookies) {
          cookies.forEach((cookie) => {
            try {
              setCookie(cookie.name, cookie.value)
            } catch (e) {
              // Swallow
            }
          })
        },
      },
    },
  )

  return next({
    context: {
      SBServerClient: client,
    },
  })
})
```

**Why validate cookies?** Supabase stores sessions as base64-encoded, chunked cookies (e.g., `sb-xyz-auth-token.0`, `sb-xyz-auth-token.1`). When cookies get corrupted (network issues, browser extensions, partial writes), the base64 decodes to invalid UTF-8, which crashes `@supabase/ssr` internally. This validation catches that and clears the bad cookies, forcing a clean re-authentication.

---

## 6. Authentication Middleware for Server Functions

This middleware chains after `supabaseMW` and validates the user's JWT:

```ts
// src/middleware/auth.ts
import { redirect } from '@tanstack/react-router'
import { createMiddleware } from '@tanstack/react-start'
import { supabaseMW } from '~/middleware/supabaseClient'

export const authentication = createMiddleware({ type: 'function' })
  .middleware([supabaseMW])
  .server(async ({ next, context }) => {
    const { SBServerClient: supabase } = context
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser()

    if (!user) {
      throw redirect({ to: '/signin' })
    }

    return next({
      context: {
        user: user,
      },
    })
  })
```

**`{ type: 'function' }`** -- This tells TanStack that this middleware is for server functions (not request-level). It runs when a server function is invoked, not on every HTTP request.

**Why `getUser()` not `getSession()`?** `getUser()` makes a server-to-server call to Supabase to verify the JWT. `getSession()` only reads from the local cookie without verification. For server-side authorization, always use `getUser()` to prevent JWT tampering. See [Section 17](#17-getsession-vs-getuser-security-implications) for details.

---

## 7. Registering Global Middleware

```ts
// src/start.ts
import { createStart } from '@tanstack/react-start'
import { supabaseMW } from '~/middleware/supabaseClient'

export const startInstance = createStart(() => {
  return {
    requestMiddleware: [supabaseMW],
  }
})
```

This registers `supabaseMW` as request-level middleware that runs on **every server request** -- SSR page loads, server function calls, and API route handlers. This ensures `context.SBServerClient` is always available everywhere on the server without having to explicitly chain it.

**The `authentication` middleware is NOT registered globally** -- it's opt-in per server function. This is intentional: unauthenticated endpoints (login, signup, public pages) need the Supabase client but not a verified user.

---

## 8. Session Retrieval: The Isomorphic Pattern

The session needs to be retrieved differently on server vs client:

```ts
// src/utils/supabase/isomorphicSupabaseSession.ts
import { createIsomorphicFn, createServerFn } from '@tanstack/react-start'
import { getSupabaseBrowserClient } from '~/utils/supabase/browserClient'

export type SerializableSession = {
  access_token: string
  refresh_token: string
}

export const isoMorphicGetSBSession = createIsomorphicFn()
  .client(async () => {
    // BROWSER: Read from browser client's in-memory/cookie session
    const supabase = getSupabaseBrowserClient()
    const {
      error,
      data: { session },
    } = await supabase.auth.getSession()

    if (!session) return null

    return {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    }
  })
  .server(async () => {
    // SERVER: Call the server function that reads from cookies
    try {
      const session = await getServerSession()
      return session
    } catch (e) {
      return null
    }
  })

// Server function -- reads session from cookies via middleware
// NOT protected by auth middleware (unauthenticated users should get null, not a redirect)
export const getServerSession = createServerFn().handler(
  async ({ context }) => {
    const { SBServerClient: supabase } = context
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session) return null

    // Validate the session by calling getUser()
    const {
      error: authErr,
      data: { user },
    } = await supabase.auth.getUser()

    if (authErr) return null

    return {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    }
  },
)
```

**Why isomorphic?** During SSR, the root `beforeLoad` runs on the server (first page load) -- it needs to read cookies. On client-side navigations, `beforeLoad` runs in the browser -- it should read from the browser client's session (which is already in memory). `createIsomorphicFn` routes to the right implementation automatically.

**Why does `getServerSession` also call `getUser()`?** Even though it reads the session with `getSession()`, it validates with `getUser()` before returning. This ensures that expired or tampered tokens return `null` rather than stale data.

---

## 9. Route Protection with beforeLoad

### Root Route: Fetch Session for All Routes

```ts
// src/routes/__root.tsx
import { createRootRouteWithContext } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { isoMorphicGetSBSession } from '~/utils/supabase/isomorphicSupabaseSession'

export type RootContext = {
  queryClient: QueryClient
  authSession: any | null
}

export const Route = createRootRouteWithContext<RootContext>()({
  beforeLoad: async () => {
    const authSession = await isoMorphicGetSBSession()
    return {
      authSession,
    }
  },
  component: RootComponent,
})
```

This runs on every route. It puts the session (or null) into the router context. It does NOT redirect -- unauthenticated users can still access public pages.

### Root Layout: Conditionally Fetch User Data

```ts
// src/routes/_rootlayout.tsx
import { createFileRoute } from '@tanstack/react-router'
import { authQueries } from '~/services/queries'

export const Route = createFileRoute('/_rootlayout')({
  beforeLoad: async ({ context }) => {
    const { authSession } = context
    let user = null

    if (authSession) {
      // Only fetch user data if we have a session -- avoids wasted calls
      const { isAuthenticated, user: authedUser } =
        await context.queryClient.fetchQuery(authQueries.user())
      if (isAuthenticated) {
        user = authedUser
      }
    }

    return { user }
  },
  component: RouteComponent,
})
```

**Performance optimization**: User data is only fetched if `authSession` exists. This means unauthenticated page loads (landing page, marketing pages) skip the `getUser()` call entirely. The fetch goes through React Query's `fetchQuery`, which caches the result -- subsequent navigations within the same session read from cache.

### Protected Layout: Redirect If Not Authenticated

```ts
// src/routes/_rootlayout/_authed.tsx
import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_rootlayout/_authed')({
  beforeLoad: async ({ context, location }) => {
    const { user } = context

    if (!user) {
      throw redirect({
        to: '/signin',
        search: {
          redirect: location.href,
        },
        statusCode: 302,
      })
    }

    return { user }
  },
  component: RouteComponent,
})
```

**File-system route nesting**: Any route file placed under `src/routes/_rootlayout/_authed/` automatically requires authentication. For example:

```
src/routes/_rootlayout/_authed/_dash/create/new.tsx    → /create/new (protected)
src/routes/_rootlayout/_authed/_dash/orders/index.tsx  → /orders (protected)
src/routes/_rootlayout/signin.tsx                       → /signin (public)
src/routes/_rootlayout/contact.tsx                      → /contact (public)
```

The `redirect` search param preserves the original URL so users return to their intended page after signing in.

### Sign-in Route: Redirect If Already Authenticated

```ts
// src/routes/_rootlayout/signin.tsx
import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'

const signInSearchSchema = z.object({
  redirect: z.string().optional(),
  signup: z.boolean().optional(),
})

export const Route = createFileRoute('/_rootlayout/signin')({
  validateSearch: signInSearchSchema,
  beforeLoad: async ({ context }) => {
    if (context.user != null) {
      throw redirect({ to: '/create/new', statusCode: 302 })
    }
  },
  component: RouteComponent,
})
```

---

## 10. Server Functions: Auth & Unauth Patterns

### Protected Server Function (requires authenticated user)

```ts
import { createServerFn } from '@tanstack/react-start'
import { authentication } from '~/middleware/auth'

export const myProtectedFunction = createServerFn({ method: 'POST' })
  .middleware([authentication]) // ← Chains supabaseMW → authentication
  .inputValidator(/* ... */)
  .handler(async ({ data, context }) => {
    // context.user is guaranteed to exist (middleware threw redirect otherwise)
    // context.SBServerClient is also available
    const { user } = context
    const { SBServerClient: supabase } = context

    // Do authenticated work...
  })
```

### Unprotected Server Function (no auth required, but Supabase client available)

```ts
import { createServerFn } from '@tanstack/react-start'

export const myPublicFunction = createServerFn()
  // No .middleware() call -- but supabaseMW still runs because it's global
  .handler(async ({ context }) => {
    // context.SBServerClient is available (from global middleware)
    // context.user does NOT exist (no authentication middleware)
    const { SBServerClient: supabase } = context

    // Can still check auth optionally:
    const {
      data: { user },
    } = await supabase.auth.getUser()
    // user may be null
  })
```

### Server-Only Function (never exposed to client)

```ts
import { createServerOnlyFn } from '@tanstack/react-start'
import { getSupabaseServerServiceRoleClient } from '~/utils/supabase/serviceRoleClient'

export const adminOnlyOperation = createServerOnlyFn(
  async (args: { userId: string }) => {
    const supabase = getSupabaseServerServiceRoleClient()
    const {
      data: { user },
    } = await supabase.auth.admin.getUserById(args.userId)
    return user
  },
)
```

**Important**: `createServerOnlyFn` is different from `createServerFn`. Server functions created with `createServerFn` are exposed as HTTP endpoints that the client can call. `createServerOnlyFn` produces a function that can ONLY be called from other server-side code -- it has no HTTP endpoint and cannot be called from the client. Use it for admin operations and internal server logic.

**Important**: `createServerOnlyFn` does NOT have access to the middleware context (no `context.SBServerClient`). It runs outside the middleware chain. That's why it creates its own Supabase client directly.

---

## 11. Auth Server Functions

### Sign In with Email/Password

```ts
// src/services/auth/auth.ts
import { createServerFn } from '@tanstack/react-start'

export type SerializableSession = {
  access_token: string
  refresh_token: string
}

export type SignInWithPasswordResponse =
  | { error: string; session: null }
  | { error: null; session: SerializableSession }

export const signInWithPassword = createServerFn({ method: 'POST' })
  .inputValidator(
    ({ email, password }: { email: string; password: string }) => {
      if (!email || !password)
        throw new Error('Email and password are required')
      return { email, password }
    },
  )
  .handler(async ({ data, context }): Promise<SignInWithPasswordResponse> => {
    const { SBServerClient: supabase } = context
    const { email, password } = data

    const { data: res, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      return {
        error: 'Invalid email or password',
        session: null,
      }
    }

    if (!res.session) {
      return {
        error: 'There was a problem signing you in.',
        session: null,
      }
    }

    // The session cookies are automatically set by @supabase/ssr via the
    // setAll() callback in the middleware. We return the tokens so the
    // client can update its in-memory state.
    return {
      error: null,
      session: {
        access_token: res.session.access_token,
        refresh_token: res.session.refresh_token,
      },
    }
  })
```

**How cookies get set**: When `signInWithPassword` succeeds, `@supabase/ssr` internally calls the `setAll()` function from the middleware's cookie config. This writes the new session tokens as `Set-Cookie` headers on the response. The browser stores them automatically. No manual cookie management needed.

### Sign Up with Email/Password

```ts
export const signUpWithPassword = createServerFn({ method: 'POST' })
  .inputValidator(
    z.object({
      email: z.string().email(),
      password: z.string().min(6),
    }),
  )
  .handler(async ({ context, data }): Promise<SignUpWithPasswordResponse> => {
    const { SBServerClient: supabase } = context
    const { email, password } = data

    const { data: res, error } = await supabase.auth.signUp({ email, password })

    if (error) {
      switch (error.code) {
        case 'email_exists':
          return { error: 'Email already exists', session: null }
        case 'user_already_exists':
          return { error: 'User already exists', session: null }
        default:
          return {
            error: 'We had a problem creating your account.',
            session: null,
          }
      }
    }

    if (!res.session) {
      return { error: 'No session returned', session: null }
    }

    return {
      error: null,
      session: {
        access_token: res.session.access_token,
        refresh_token: res.session.refresh_token,
      },
    }
  })
```

### Sign Up / Sign In with Google OAuth

```ts
export const signUpWithGoogle = createServerFn({ method: 'POST' })
  .inputValidator((data: { redirect?: string }) => data)
  .handler(async ({ data: { redirect }, context }) => {
    const { SBServerClient: supabase } = context
    const origin = getRequestHeader('origin') || 'https://yoursite.com'

    let postAuthRedirectTo = `${origin}/oauth/callback`
    if (redirect) {
      postAuthRedirectTo = `${origin}/oauth/callback?redirect=${redirect}`
    }

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: postAuthRedirectTo,
      },
    })

    if (!error) {
      return { error: null, redirectUrl: data.url }
    }
    return { error: error.message, redirectUrl: null }
  })
```

**Client-side handling**: The client does a full page redirect (`window.location.href = redirectUrl`) to Google's OAuth page. This is NOT a client-side navigation -- it leaves your app entirely. After Google auth, the user is redirected back to your `/oauth/callback` route.

### Sign Out

```ts
export const signOut = createServerFn().handler(async ({ context }) => {
  const { SBServerClient: supabase } = context
  await supabase.auth.signOut()
  // This clears the session cookies via setAll()
})
```

### Get User

```ts
export type SerializableUser = {
  id: string
  email?: string
  firstName?: string
  lastName?: string
}

export type GetUserResponse =
  | { isAuthenticated: false; user: null }
  | { isAuthenticated: true; user: SerializableUser }

export const getUser = createServerFn().handler(
  async ({ context }): Promise<GetUserResponse> => {
    const { SBServerClient: supabase } = context
    const { data } = await supabase.auth.getUser()

    if (!data.user) {
      return { isAuthenticated: false, user: null }
    }

    return {
      isAuthenticated: true,
      user: {
        id: data.user.id,
        email: data.user.email,
        firstName: data.user.user_metadata.first_name,
        lastName: data.user.user_metadata.last_name,
      },
    }
  },
)
```

**Why return a serializable user?** The Supabase `User` object contains circular references and non-serializable data. Server functions must return JSON-serializable data. Extract only what you need.

---

## 12. OAuth Callback Route (Google)

This is an API route (server-only, no React component) that handles the OAuth code exchange:

```ts
// src/routes/oauth/callback.tsx
import { createFileRoute, redirect } from '@tanstack/react-router'
import { createServerOnlyFn } from '@tanstack/react-start'
import { getResponseHeaders } from '~/services/startWebUtils'
import { SupabaseClient } from '@supabase/supabase-js'

export const Route = createFileRoute('/oauth/callback')({
  server: {
    handlers: {
      GET: async ({ request, context }) => {
        const { SBServerClient: supabase } = context
        const searchparams = new URL(request.url).searchParams
        const code = searchparams.get('code')
        const redirectAfterAuth = searchparams.get('redirect')

        if (!code) {
          throw redirect({ to: '/signin', statusCode: 302 })
        }

        // Exchange the OAuth code for a session
        const { error, session } = await exchangeCodeForSession({
          supabase,
          code,
        })

        // CRITICAL: Manually forward Set-Cookie headers
        // supabase/ssr writes cookies via TanStack's setCookie utility,
        // but when constructing a raw Response object, those headers
        // are NOT automatically included. You must read them from the
        // response headers in AsyncLocalStorage and forward them.
        const headers = new Headers()
        const setCookies = getResponseHeaders().getSetCookie()
        setCookies.forEach((sc) => {
          headers.append('Set-Cookie', sc)
        })

        if (error || !session) {
          headers.set('Location', '/signin')
          return new Response(null, { status: 302, headers })
        }

        let redirectUrl = redirectAfterAuth || '/create/new'

        headers.set('Location', redirectUrl)
        return new Response(null, { status: 302, headers })
      },
    },
  },
})

const exchangeCodeForSession = createServerOnlyFn(
  async (args: { supabase: SupabaseClient; code: string }) => {
    const { code, supabase } = args
    const { data: res, error } =
      await supabase.auth.exchangeCodeForSession(code)

    if (error) {
      return { error: error.message, session: null }
    }

    return {
      error: null,
      session: {
        access_token: res.session.access_token,
        refresh_token: res.session.refresh_token,
      },
    }
  },
)
```

**The `Set-Cookie` header forwarding is the most important gotcha in this entire setup.** When you construct a `new Response()` in a TanStack Start API route handler, the cookies that `@supabase/ssr` set via `setCookie()` are stored on the internal Nitro response object (in `AsyncLocalStorage`). Your manually constructed `Response` doesn't inherit those headers. You MUST read them with `getResponseHeaders().getSetCookie()` and append them to your response. If you skip this, the OAuth flow will appear to succeed but the user will have no session cookies, effectively not being logged in.

**Configure in Supabase Dashboard**: Your OAuth callback URL must be registered in Supabase Dashboard → Authentication → URL Configuration → Redirect URLs. Add `https://yoursite.com/oauth/callback` (and `http://localhost:3000/oauth/callback` for development).

---

## 13. Magic Link / OTP Callback Route

Same pattern as OAuth callback, with OTP verification instead of code exchange:

```ts
// src/routes/auth/magicLink.tsx
import { createFileRoute } from '@tanstack/react-router'
import { getResponseHeaders } from '~/services/startWebUtils'

export const Route = createFileRoute('/auth/magicLink')({
  server: {
    handlers: {
      GET: async ({ request, context }) => {
        const { SBServerClient: supabase } = context
        const searchparams = new URL(request.url).searchParams
        const token_hash = searchparams.get('token_hash')
        const type = searchparams.get('type')

        if (type === 'email' && token_hash) {
          const { data: otpRes, error: otpError } =
            await supabase.auth.verifyOtp({
              token_hash,
              type: 'email',
            })

          // Same Set-Cookie forwarding as OAuth callback
          const headers = new Headers()
          const setCookies = getResponseHeaders().getSetCookie()
          setCookies.forEach((sc) => {
            headers.append('Set-Cookie', sc)
          })

          if (otpError || !otpRes?.session) {
            headers.set('Location', '/signin')
            return new Response(null, { status: 302, headers })
          }

          headers.set('Location', '/create/new')
          return new Response(null, { status: 302, headers })
        }

        return new Response(null, { status: 400 })
      },
    },
  },
})
```

---

## 14. React Query Caching: Avoiding Redundant Supabase Calls

### Query Definition

```ts
// src/services/queries.ts
import { queryOptions } from '@tanstack/react-query'
import { getUser } from 'src/services/auth/auth'

export const authQueries = {
  all: 'auth',
  user: () =>
    queryOptions({
      queryKey: [authQueries.all, 'user'],
      queryFn: () => getUser(),
    }),
}
```

### How It Prevents Redundant Calls

The root layout's `beforeLoad` uses `context.queryClient.fetchQuery(authQueries.user())`. Here's what happens:

1. **First page load (SSR)**: `fetchQuery` calls `getUser()` server function → calls `supabase.auth.getUser()` → result cached with key `['auth', 'user']`.
2. **Client-side navigation to another route**: `beforeLoad` runs again in the browser. `fetchQuery` checks the cache -- data is still fresh (within 5-minute stale time) → returns cached data, NO server call.
3. **After 5 minutes**: Data becomes stale. Next navigation triggers a background refetch.
4. **After sign-out**: Invalidate the query cache to clear stale user data.

### Router Configuration

```ts
// src/router.tsx
import { createRouter } from '@tanstack/react-router'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60 * 5, // 5 minutes
        retry: 0,
        refetchOnWindowFocus: false,
      },
    },
  })

  const router = createRouter({
    routeTree,
    context: { queryClient, authSession: null },
    scrollRestoration: true,
    defaultPreload: 'intent',
  })

  // This integrates React Query with TanStack Router's SSR
  // Data fetched during SSR is dehydrated and rehydrated on the client
  setupRouterSsrQueryIntegration({ router, queryClient })

  return router
}
```

`setupRouterSsrQueryIntegration` is critical -- it ensures that React Query data fetched during SSR is serialized into the HTML and rehydrated on the client. Without it, the client would refetch everything on hydration.

---

## 15. Router Setup

The router context makes `queryClient` and `authSession` available to all route `beforeLoad` hooks:

```ts
// In router.tsx
const router = createRouter({
  routeTree,
  context: { queryClient, authSession: null, countryCodeFromHeaders: null },
})
```

The `authSession: null` is the initial value. It gets overridden by the root route's `beforeLoad` which sets it to the actual session (or null if unauthenticated). This context flows down to all child routes automatically.

---

## 16. The Chunked Cookie Problem

Supabase sessions are JSON objects that get base64-encoded. The encoded string can exceed browser cookie size limits (~4KB per cookie). `@supabase/ssr` handles this by splitting the value across multiple cookies:

```
sb-abcdefgh-auth-token.0 = "base64-eyJhY2Nlc3NfdG9rZW4iOi..."  (first 3600 chars)
sb-abcdefgh-auth-token.1 = "JleHAiOjE3MTg5MDEyMzQsImlh..."  (remaining chars)
```

**The problem**: If the browser or network corrupts one chunk (missing bytes, encoding issues), the reassembled base64 decodes to invalid UTF-8, which crashes `@supabase/ssr` with an unhandled error. See: https://github.com/supabase/ssr/issues/67

**The solution** (implemented in `supabaseMW`):

1. Before creating the Supabase client, scan all cookies for `sb-*-auth-token` patterns
2. Reassemble chunked cookies by sorting chunks by index
3. Attempt to base64-decode and UTF-8-validate the combined value
4. If validation fails, delete ALL chunks and return a 400 error
5. The user will be treated as unauthenticated and need to sign in again

This is a defensive measure. Without it, a single corrupted cookie byte takes down the entire request with a cryptic error.

---

## 17. getSession() vs getUser(): Security Implications

**`supabase.auth.getSession()`**

- Reads the JWT from the cookie/memory
- Does NOT validate it with Supabase's servers
- Fast (no network call)
- **Vulnerable to JWT tampering** -- an attacker could modify the JWT payload, and `getSession()` would still return the modified data
- **Use for**: Quick checks on the client, determining if a session _probably_ exists, getting tokens to pass to APIs

**`supabase.auth.getUser()`**

- Sends the JWT to Supabase's auth server for verification
- Returns the user only if the JWT is valid and not expired
- Slower (network call to Supabase)
- **Secure** -- cannot be spoofed
- **Use for**: All server-side authorization decisions, any time you need to trust the user's identity

**Rules of thumb:**

- Client-side: `getSession()` is fine for UI decisions (show/hide elements)
- Server-side route `beforeLoad` during SSR: The root route uses `getSession()` (via isomorphic fn) for speed, but the root layout then validates with `getUser()` via `fetchQuery(authQueries.user())`
- Server function middleware: Always `getUser()`
- API route handlers: Always `getUser()`

---

## 18. Common Pitfalls & Gotchas

### 1. Missing Set-Cookie headers in API route responses

When you create `new Response()` in a TanStack Start API route handler (like OAuth callback), cookies set by `@supabase/ssr` are NOT automatically included. You must manually read them from `getResponseHeaders().getSetCookie()` and append them. This is the #1 cause of "OAuth works but user isn't logged in" bugs.

### 2. Service role client must use `@supabase/supabase-js`, NOT `@supabase/ssr`

The `@supabase/ssr` package's `createServerClient` always tries to use cookies for auth. When you pass a service role key, it still reads the user's cookie session, resulting in incorrect privileges. Always use `createClient` from `@supabase/supabase-js` for admin operations.

### 3. Server-only files that break the client build

Files importing server-only modules (like `serviceRoleClient.ts` or files using Node APIs) cannot be imported -- even transitively -- by client-side code. If a route component imports a file that imports a server-only module, the build will fail with unhelpful errors. Use `createServerOnlyFn` to fence server code, and keep server-only files isolated (never import them from route components or shared modules).

### 4. `@tanstack/react-start/server` imports in shared files

Functions like `getCookies()`, `setCookie()`, etc. from `@tanstack/react-start/server` only work during an active server request (they use `AsyncLocalStorage`). If you import them in a file that's also bundled for the client, the build breaks. Always wrap them with `createServerOnlyFn`.

### 5. OAuth redirect URL must be registered in Supabase Dashboard

Go to Supabase Dashboard → Authentication → URL Configuration → Redirect URLs. Add your callback URLs:

- `http://localhost:3000/oauth/callback` (development)
- `https://yourdomain.com/oauth/callback` (production)
- `https://yourdomain.com/auth/magicLink` (if using magic links)

### 6. Cookie-based auth and Supabase Realtime

The browser client reads the session from cookies, but Supabase Realtime channels need an explicit auth token. Call `supabase.realtime.setAuth()` after creating the browser client. Re-call it when the window regains focus (the token may have been refreshed while the tab was backgrounded):

```ts
useEffect(() => {
  const setAuth = async () => {
    await supabase.realtime.setAuth()
  }
  setAuth()
}, [supabase])
```

### 7. Google OAuth uses full page redirect, not client-side navigation

`signInWithOAuth()` returns a URL to Google's consent page. You must do `window.location.href = url` (full page navigation), not `router.navigate()`. The user leaves your app, authenticates with Google, and returns to your callback URL.

### 8. Return serializable data from server functions

The Supabase `User` and `Session` objects contain non-serializable properties. Always map them to plain objects with only the fields you need before returning from server functions.

### 9. Don't call `supabase.auth.getUser()` on every route navigation

This makes a network call to Supabase on every navigation. Use the pattern from this guide: fetch once, cache with React Query for 5 minutes. The root `beforeLoad` only checks if a session _exists_ (fast, no network call). User validation happens once via React Query and is cached.

---

## 19. File Structure Summary

```
src/
├── start.ts                          # Global middleware registration
├── server.ts                         # Server entry point
├── router.tsx                        # Router + QueryClient setup
├── middleware/
│   ├── supabaseClient.ts             # Global MW: creates SBServerClient, cookie validation
│   └── auth.ts                       # Function MW: validates user, adds to context
├── utils/supabase/
│   ├── browserClient.ts              # createBrowserClient for client-side
│   ├── serviceRoleClient.ts          # Admin client (supabase-js, NOT ssr)
│   └── isomorphicSupabaseSession.ts  # Isomorphic session getter
├── services/
│   ├── startWebUtils.ts              # Wrappers for TanStack server utilities
│   ├── queries.ts                    # React Query definitions (authQueries.user())
│   └── auth/
│       ├── auth.ts                   # Server fns: signIn, signUp, signOut, getUser
│       └── authServer.ts             # Server-only fns: getUserById (admin)
├── routes/
│   ├── __root.tsx                    # Root: fetches session isomorphically
│   ├── _rootlayout.tsx               # Layout: fetches user if session exists
│   ├── _rootlayout/
│   │   ├── signin.tsx                # Public: sign in/up page
│   │   ├── _authed.tsx               # Protected layout: redirects if no user
│   │   └── _authed/                  # All protected routes nested here
│   ├── oauth/
│   │   └── callback.tsx              # API route: OAuth code exchange
│   └── auth/
│       └── magicLink.tsx             # API route: Magic link verification
├── components/auth/
│   ├── AuthPage.tsx                  # Wrapper toggling login/signup forms
│   ├── LoginForm.tsx                 # Email/password + Google login
│   └── SignupForm.tsx                # Email/password + Google signup
└── hooks/dataListen/
    └── supabaseChannelsContext.tsx    # Realtime auth + channel management
```

---

## 20. Complete Flow Diagrams

### Email/Password Sign In Flow

```
User submits email + password
  → LoginForm calls signInWithPassword({ data: { email, password } })
    → Server function executes (supabaseMW runs first, creates SBServerClient)
      → supabase.auth.signInWithPassword({ email, password })
        → Supabase returns session tokens
        → @supabase/ssr calls setAll() → setCookie() writes Set-Cookie headers
      → Returns { session: { access_token, refresh_token } }
    → Response includes Set-Cookie headers (browser stores them)
  → LoginForm calls router.navigate({ to: '/create/new' })
    → __root beforeLoad: isoMorphicGetSBSession() reads session from cookies ✓
    → _rootlayout beforeLoad: fetchQuery(authQueries.user()) fetches + caches user ✓
    → _authed beforeLoad: user exists → allows access ✓
```

### Google OAuth Sign In Flow

```
User clicks "Continue with Google"
  → SignupForm calls signUpWithGoogle({ data: { redirect } })
    → Server function calls supabase.auth.signInWithOAuth({ provider: 'google' })
    → Returns { redirectUrl: 'https://accounts.google.com/...' }
  → Client does window.location.href = redirectUrl (FULL PAGE REDIRECT)
  → User authenticates with Google
  → Google redirects to: /oauth/callback?code=abc123&redirect=/create/new
    → API route handler runs (supabaseMW creates SBServerClient)
      → exchangeCodeForSession({ supabase, code })
        → supabase.auth.exchangeCodeForSession(code)
        → @supabase/ssr calls setAll() → cookies written to internal response
      → Handler reads cookies from getResponseHeaders().getSetCookie()
      → Handler creates Response with Location + Set-Cookie headers
    → Browser receives 302 + Set-Cookie → stores cookies → follows redirect
  → User lands on /create/new with valid session cookies
```

### SSR Page Load (Authenticated User)

```
Browser requests /create/new (protected route)
  → Server receives request
    → supabaseMW (global): validates cookies, creates SBServerClient
    → __root beforeLoad: getServerSession() → getSession() + getUser() → returns tokens
    → _rootlayout beforeLoad: authSession exists → fetchQuery(getUser()) → caches user
    → _authed beforeLoad: user exists → allows access
    → Route loader runs, fetches route-specific data
    → React renders to HTML with user data
  → HTML sent to client with dehydrated React Query cache
  → Client hydrates -- React Query cache already has user data (no refetch)
```

### Client-Side Navigation (Authenticated User)

```
User clicks link to /orders (another protected route)
  → TanStack Router handles client-side navigation
    → __root beforeLoad: isoMorphicGetSBSession() → browser client getSession() (no server call)
    → _rootlayout beforeLoad: authSession exists → fetchQuery(getUser()) → CACHE HIT (< 5 min)
    → _authed beforeLoad: user exists → allows access
    → Route loader runs for /orders
  → No auth-related server calls were made -- everything from cache
```
