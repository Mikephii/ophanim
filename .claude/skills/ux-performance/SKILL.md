---
name: ux-performance
description: Performance optimization and user experience patterns. Use when adding progress reporting, parallelizing API calls, optimizing latency, or improving CLI/extension feedback loops.
---

# UX & Performance Standards

## Mandate

Fast is good UX. Every user-facing operation must provide feedback and complete as quickly as possible. Users should never stare at a silent terminal wondering if the tool is stuck.

## Concurrency Patterns

All external API calls (Claude, Supabase) use `p-limit` for bounded parallelism. Never `await` in a sequential loop when calls are independent.

### Claude API -- `pLimit(5)`

- Function analysis batches (10 functions each) fire 5 at a time
- L1/CC summarization fires up to 5 Claude calls concurrently
- L2 summarization uses `pLimit(3)` (fewer, larger calls)
- `p-retry` handles 429 rate limits with 4 retries -- safe to run concurrent

```typescript
import pLimit from "p-limit";

const limit = pLimit(5);
await Promise.all(batches.map((batch) => limit(async () => {
  const result = await analyzeFunctions(batch);
  // DB inserts are synchronous (better-sqlite3), no race conditions
})));
```

### Supabase -- `pLimit(3)`

- Push/pull chunk loops use `parallelChunks()` helper in `sync.ts`
- GC deletes use batched `.in()` queries instead of per-row deletes
- Conservative concurrency (3) for PostgREST connection pooling

```typescript
// Helper in sync.ts -- reuse for all chunked Supabase operations
async function parallelChunks<T>(
  rows: T[], chunkSize: number, fn: (chunk: T[]) => Promise<void>
): Promise<void> {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(rows.slice(i, i + chunkSize));
  }
  await Promise.all(chunks.map((chunk) => supabaseLimit(() => fn(chunk))));
}
```

## Progress Reporting

Every operation that takes more than ~1 second must show progress to the user.

### Callback Patterns

| Phase | Callback | Signature | Output |
|-------|----------|-----------|--------|
| File scanning | `onProgress` | `(current, total, fileName)` | `[1/144] src/foo.ts` |
| Claude analysis | `onAnalysisProgress` | `(analyzed, total)` | `Analyzing: 10/42 functions` |
| Cloud sync | `onProgress` | `(stepDescription)` | `Pushing analysis...` |
| Summarization | `onProgress` | `(stepDescription)` | `Summarizing community 3...` |

### TTY Updates

For frequently updating progress (like analysis), use in-place line updates:

```typescript
if (process.stdout.isTTY) {
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
}
process.stdout.write(`  Analyzing: ${analyzed}/${total} functions`);
```

### Minimum Feedback Rules

1. **Before a long operation**: Print what's about to happen (`"Pulling 162 analyses from cloud..."`)
2. **During**: Update with progress count if >5 items (`"50/162 hashes..."`)
3. **After**: Print result summary (`"Pulled 120 analyses from cloud"`)

## Anti-Patterns

- **Sequential await in a loop** when calls are independent -- use `Promise.all` + `pLimit`
- **Per-row Supabase deletes** -- batch with `.in()` operator (50 per chunk)
- **Silent long operations** -- always add progress callbacks
- **Unbounded parallelism** -- always use `pLimit` to prevent rate limiting / connection exhaustion

## Key Files

- `packages/core/src/index.ts` -- `analyzeFiles()`, `analyzeRepository()` -- function analysis pipeline
- `packages/core/src/summarize.ts` -- `summarizeCommunities()` -- L1/L2/L3/CC summarization
- `packages/cli/src/sync.ts` -- `syncToSupabase()`, `pullFromSupabase()`, `parallelChunks()` helper
- `packages/cli/src/index.ts` -- CLI progress wiring for analyze/graph commands
