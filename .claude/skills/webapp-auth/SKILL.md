---
name: webapp-auth
description: Webapp authentication and API route patterns. Use when working on Supabase SSR middleware, server functions, route protection, session management, or the query system.
---

# Webapp Authentication & API Patterns

## Three Supabase Client Types

| Client | Purpose | Auth Method | Location |
|--------|---------|-------------|----------|
| **SBServerClient** | Server-side queries (RLS scoped) | Cookie-based (SSR) | `context` from `supabaseMW` |
| **Service Role Client** | Admin operations (CLI token gen) | API key (no session) | `utils/supabase/serviceRoleClient.ts` |
| **Browser Client** | Client-side session management | localStorage (Supabase) | `utils/supabase/browserClient.ts` |

## Middleware Chain

### 1. Supabase SSR Middleware (`middleware/supabaseClient.ts`)

Runs on **every request** via TanStack Start's `requestMiddleware`:

```typescript
// start.ts
export const startInstance = createStart(() => ({
  requestMiddleware: [supabaseMW],
}))
```

Creates `SBServerClient` from cookies. Key features:
- **Chunked cookie support:** Handles split cookies (`sb-*-auth-token.0`, `.1`, etc.)
- **Corruption detection:** Validates UTF-8 encoding, catches base64-encoded cookies
- **Auto-refresh:** Session persistence and token refresh via `@supabase/ssr`

### 2. Authentication Middleware (`middleware/auth.ts`)

For protected endpoints. Chains after `supabaseMW`:

```typescript
export const authentication = createMiddleware({ type: 'function' })
  .middleware([supabaseMW])
  .server(async ({ next, context }) => {
    const { data: { user } } = await context.SBServerClient.auth.getUser()
    if (!user) throw redirect({ to: '/signin' })
    return next({ context: { user } })  // Adds user to context
  })
```

## Server Function Patterns

### Pattern 1: Public (RLS-protected, no explicit auth check)
```typescript
export const getRepos = createServerFn().handler(
  async ({ context }): Promise<Repo[]> => {
    const { SBServerClient: supabase } = context as any
    // RLS automatically filters by user_id
    const { data } = await supabase.from('repos').select('*')
    return data ?? []
  },
)
```

### Pattern 2: With Input Validation
```typescript
export const getRepo = createServerFn({ method: 'GET' })
  .inputValidator((data: { id: string }) => data)  // NOT .validator()!
  .handler(async ({ data, context }): Promise<Repo | null> => {
    const { SBServerClient: supabase } = context as any
    const { data: repo } = await supabase
      .from('repos')
      .select('*')
      .eq('id', data.id)
      .single()
    return repo
  })
```

### Pattern 3: Protected with Auth Middleware
```typescript
export const generateCliToken = createServerFn({ method: 'POST' })
  .middleware([authentication])
  .handler(async ({ context }): Promise<Response> => {
    const { user } = context  // Pre-validated by middleware
    const serviceClient = getSupabaseServiceRoleClient()
    // Admin operations here
  })
```

## Route Protection

### Root Route (`routes/__root.tsx`)
```typescript
export const Route = createRootRouteWithContext<RootContext>()({
  beforeLoad: async () => {
    const authSession = await isomorphicGetSBSession()
    return { authSession }  // Available to all child routes
  },
})
```

### Protected Routes (`routes/dashboard.tsx`)
```typescript
export const Route = createFileRoute('/dashboard')({
  beforeLoad: async ({ context }) => {
    if (!context.authSession) {
      throw redirect({ to: '/signin', statusCode: 302 })
    }
    const userData = await context.queryClient.fetchQuery(authQueries.user())
    if (!userData.isAuthenticated) {
      throw redirect({ to: '/signin', statusCode: 302 })
    }
    return { user: userData.user }
  },
})
```

**Double-check pattern:** Client-side session check (fast) + server verification (authoritative).

## Isomorphic Session (`utils/supabase/isomorphicSupabaseSession.ts`)

```typescript
export const isomorphicGetSBSession = createIsomorphicFn()
  .client(async () => {
    // Browser: localStorage-based session via Supabase client
    const { data: { session } } = await supabase.auth.getSession()
    // Validate with getUser() to catch expired tokens
    return session ? { access_token, refresh_token } : null
  })
  .server(async () => {
    // SSR: cookie-based session via middleware
    return await getServerSession()
  })
```

## Query System (TanStack Query)

### Query Keys (`services/queries/keys.ts`)
```typescript
export const queryKeys = {
  repos: {
    list: () => ['repos', 'list'] as const,
    detail: (id: string) => ['repos', 'detail', id] as const,
  },
  functions: {
    list: (repoId: string, filters?: FunctionFilters & PaginationParams) =>
      ['repos', repoId, 'functions', 'list', filters] as const,
  },
  architecture: {
    hierarchy: (repoId: string, algorithm?: string) =>
      ['repos', repoId, 'architecture', 'hierarchy', algorithm ?? 'louvain'] as const,
  },
  // ... more keys
}
```

### QueryOptions Pattern
```typescript
export const repoQueries = {
  list: () => queryOptions({
    queryKey: queryKeys.repos.list(),
    queryFn: () => getRepos(),
  }),
  detail: (id: string) => queryOptions({
    queryKey: queryKeys.repos.detail(id),
    queryFn: () => getRepo({ data: { id } }),
  }),
}
```

### Usage in Components
```typescript
const { data: repos } = useQuery(repoQueries.list())
```

### Client Configuration
```typescript
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,        // 5 min stale time
      retry: 0,
      refetchOnWindowFocus: false,
    },
  },
})
```

## Analysis Merging (`services/api/merge.ts`)

Supabase stores split rows (documentation + security). Webapp merges for display:

```typescript
export function mergeAnalysisRows(rows): MergedAnalysis {
  // Groups by content_hash, combines doc + sec into nested shape
  return { documentation: { ... }, security: { ... } }
}

export function buildAnalysisMap(rows): Map<string, MergedAnalysis> {
  // Groups rows by content_hash, merges each group
}
```

**Note:** Webapp merge returns **nested** shape (`{ documentation, security }`). Core merge returns **flat** shape (`{ description, params, dataTags, ... }`). They are intentionally different.

## Key Files

- `packages/webapp/src/middleware/supabaseClient.ts` -- SSR Supabase client setup
- `packages/webapp/src/middleware/auth.ts` -- Authentication middleware
- `packages/webapp/src/services/api/*.ts` -- Server functions
- `packages/webapp/src/services/queries/*.ts` -- Query definitions
- `packages/webapp/src/utils/supabase/` -- Client factories
- `packages/webapp/src/routes/__root.tsx` -- Root route + session
