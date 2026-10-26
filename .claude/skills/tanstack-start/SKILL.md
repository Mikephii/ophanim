---
name: tanstack-start
description: TanStack Start and TanStack Query patterns and correct API usage. Use when creating server functions, routes, middleware, or query definitions. Critical for avoiding deprecated API calls.
---

# TanStack Start Patterns

TanStack Start is under active development. This skill tracks the **correct, current API** for Ophan's version.

## Current Versions

```json
{
  "@tanstack/react-start": "^1.132.0",
  "@tanstack/react-query": "^5.90.20",
  "@tanstack/react-router": "^1.132.0"
}
```

## Server Functions

### Correct API: `.inputValidator()` (NOT `.validator()`)

The `.validator()` method was **renamed** to `.inputValidator()`. Using `.validator()` will fail silently or throw.

```typescript
// CORRECT
export const getRepo = createServerFn({ method: 'GET' })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data, context }) => { ... })

// WRONG - deprecated name
export const getRepo = createServerFn({ method: 'GET' })
  .validator((data: { id: string }) => data)  // THIS WILL NOT WORK
  .handler(async ({ data, context }) => { ... })
```

### Server Function Patterns

**No input:**
```typescript
export const getRepos = createServerFn().handler(
  async ({ context }): Promise<Repo[]> => {
    const { SBServerClient: supabase } = context as any
    const { data } = await supabase.from('repos').select('*')
    return data ?? []
  },
)
```

**With input:**
```typescript
export const getRepo = createServerFn({ method: 'GET' })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data, context }): Promise<Repo | null> => {
    const { SBServerClient: supabase } = context as any
    const { data: repo } = await supabase
      .from('repos').select('*').eq('id', data.id).single()
    return repo
  })
```

**With middleware:**
```typescript
export const protectedAction = createServerFn({ method: 'POST' })
  .middleware([authentication])
  .handler(async ({ context }) => {
    const { user } = context  // Added by authentication middleware
    // ...
  })
```

**With both:**
```typescript
export const updateRepo = createServerFn({ method: 'POST' })
  .middleware([authentication])
  .inputValidator((data: { id: string; name: string }) => data)
  .handler(async ({ data, context }) => {
    const { user } = context
    // ...
  })
```

### Context Access

Server functions receive context from middleware. The `context as any` pattern is a **known exception** in this codebase until TanStack Start middleware types improve:

```typescript
const { SBServerClient: supabase } = context as any  // Known pattern
```

### Calling Server Functions

From client code or route loaders:
```typescript
// Direct call
const repos = await getRepos()

// With input
const repo = await getRepo({ data: { id: 'abc' } })
```

## Middleware

### Creating Middleware

```typescript
// Request-level (runs on every request)
export const supabaseMW = createMiddleware().server(async ({ next }) => {
  const client = createSupabaseClient(...)
  return next({ context: { SBServerClient: client } })
})

// Function-level (runs per server function)
export const authentication = createMiddleware({ type: 'function' })
  .middleware([supabaseMW])  // Chain dependencies
  .server(async ({ next, context }) => {
    const { data: { user } } = await context.SBServerClient.auth.getUser()
    if (!user) throw redirect({ to: '/signin' })
    return next({ context: { user } })
  })
```

### Start Instance Setup

```typescript
// start.ts
import { createStart } from '@tanstack/react-start'
export const startInstance = createStart(() => ({
  requestMiddleware: [supabaseMW],  // Runs before ALL routes + server functions
}))
```

## Routes

### Route Context

```typescript
// Root provides context to all children
export const Route = createRootRouteWithContext<{
  queryClient: QueryClient
  authSession: Session | null
}>()({
  beforeLoad: async () => {
    const authSession = await isomorphicGetSBSession()
    return { authSession }
  },
  component: RootComponent,
})
```

### Protected Routes

```typescript
export const Route = createFileRoute('/dashboard')({
  beforeLoad: async ({ context }) => {
    if (!context.authSession) {
      throw redirect({ to: '/signin', statusCode: 302 })
    }
    return { user: userData.user }
  },
})
```

### File-Based Routing

```
src/routes/
  __root.tsx                          → Root layout
  index.tsx                           → /
  signin.tsx                          → /signin
  dashboard.tsx                       → /dashboard (layout)
  dashboard/
    index.tsx                         → /dashboard
    repos/
      $repoId/
        index.tsx                     → /dashboard/repos/:repoId
        architecture/
          index.tsx                   → /dashboard/repos/:repoId/architecture
          $communityId.tsx            → /dashboard/repos/:repoId/architecture/:communityId
```

## TanStack Query Integration

### queryOptions Pattern

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

### Query Keys Convention

```typescript
export const queryKeys = {
  repos: {
    list: () => ['repos', 'list'] as const,
    detail: (id: string) => ['repos', 'detail', id] as const,
  },
  functions: {
    list: (repoId: string, filters?: Filters) =>
      ['repos', repoId, 'functions', 'list', filters] as const,
  },
}
```

All keys include filter params so cache invalidates correctly on filter changes.

### Usage in Components

```typescript
const { data, isLoading } = useQuery(repoQueries.list())
```

### Isomorphic Functions

```typescript
export const isomorphicGetSBSession = createIsomorphicFn()
  .client(async () => {
    // Browser: localStorage
  })
  .server(async () => {
    // SSR: cookies
  })
```

## Common Gotchas

1. **`.inputValidator()` not `.validator()`** -- renamed in current version
2. **`context as any`** -- known exception until middleware types improve
3. **Route params via `$paramName`** -- file naming convention (`$repoId.tsx`)
4. **`createServerFn({ method: 'POST' })`** -- specify method for mutations
5. **Query keys must include all filters** -- or cache won't invalidate on filter change
6. **`throw redirect()`** -- use `throw` not `return` for redirects in `beforeLoad`

## Key Files

- `packages/webapp/src/start.ts` -- Start instance + request middleware
- `packages/webapp/src/router.tsx` -- Router + QueryClient config
- `packages/webapp/src/middleware/` -- Supabase + auth middleware
- `packages/webapp/src/services/api/*.ts` -- Server functions
- `packages/webapp/src/services/queries/*.ts` -- Query definitions + keys
- `packages/webapp/src/routeTree.gen.ts` -- Auto-generated route tree
