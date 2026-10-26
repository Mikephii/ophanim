# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ophan is an open-source (MIT), AI-powered code security and intelligence platform. It uses TypeScript AST parsing and Claude to detect security vulnerabilities, map data flows, and auto-document codebases. Ships as a CLI + VS Code extension. Optional cloud sync and a web dashboard run on a self-hosted server (Supabase + the `webapp` package); see `docs/self-hosting.md`.

## Engineering Philosophy

This project should reflect professional TypeScript engineering standards. Invest in code quality; don't take shortcuts that create tech debt.

- **Useful abstractions over raw data manipulation.** Never index into arrays by position or rely on structural ordering assumptions. Use named fields, typed accessors, `Map` lookups, or getter methods. If you find yourself writing `items[0]` or `result[2]`, that's a sign the data needs a named shape.
- **DRY after the pattern is clear.** When logic repeats across two or more call sites, extract it into a shared function or utility. Don't duplicate-and-diverge. But don't abstract on the first occurrence -- wait until the pattern is established (rule of three for non-trivial abstractions).
- **Proactively refactor.** When implementing a feature reveals that existing code would benefit from a better abstraction, propose the refactor to the user. Don't silently accumulate mess -- surface opportunities to improve the codebase as they become apparent.
- **Simple, readable abstractions.** Every abstraction must earn its complexity. No leaky abstractions that force callers to understand internals. No premature abstraction of things that aren't yet repeated. No over-the-top patterns like deep inheritance hierarchies, abstract factories, or generic-heavy type gymnastics. If an abstraction is harder to understand than the code it replaces, it's not an improvement.
- **Classes only where they earn it.** Use classes when you genuinely need encapsulated state + behavior together (e.g., `ExtensionStore`, `Database` wrappers). Prefer plain functions, typed objects, and modules everywhere else. Don't wrap a single function in a class.
- **Composable and extensible.** Code should be easy to recompose for new use cases. Prefer small, focused functions that can be combined over monolithic functions that do everything. Design for the next developer's comprehension -- clear naming, obvious data flow, minimal hidden state.
- **Documentation through code and comments.** Code should be self-documenting through clear naming and structure. Comments explain "why" (design decisions, non-obvious constraints, trade-offs), not "what" (which the code already shows). Public APIs and complex algorithms deserve doc comments. Internal plumbing that's obvious from context does not.

## Product Requirements

### Core Value Proposition

- **Security-first**: Position as "AI security analysis for dev teams", not generic "code intelligence"
- **Local-first**: All analysis stored in per-repo gitignored SQLite. No cloud required for core functionality
- **Content-addressed**: Analysis keyed by SHA256 of function source. Branch-agnostic, merge-friendly, sync-friendly
- **Dev dependency distribution**: Install via `npm install @ophan/cli`, init via `npx @ophan/cli init`, analyze via `npx @ophan/cli watch`
- **General-purpose**: Analysis must work on any arbitrary codebase -- single-package projects, monorepos of any structure, any language. Never hardcode directory layout assumptions. Use marker file discovery (package.json, go.mod, pyproject.toml, Cargo.toml) for package detection. Use directory distance for clustering proximity. Degrade gracefully when markers are absent.

### False Negatives Over False Positives

When the system is uncertain, always err on the side of **under-reporting** rather than over-reporting. False negatives go unnoticed -- the user simply doesn't see something, and the system self-heals on the next analysis cycle. False positives actively destroy trust with the user.

This principle applies across all heuristic, detection, and display systems:

- **Issue remediation detection**: If the user edits code that has an issue squiggle, suppress the squiggle immediately. If the edit didn't actually fix the issue, the squiggle returns in ~15 seconds when watch re-analysis runs. The user never notices the brief absence. But if we keep showing a red "eval vulnerability" squiggle on code the user just changed to `JSON.parse(data)`, we punish them for fixing the issue and they lose trust in the product.

- **Stale detection**: If we're unsure whether analysis is current, mark it stale (hide/dim it). Showing confidently wrong information is worse than showing nothing. The user sees a brief loading state; the system catches up.

- **Anchor resolution**: If we can't find the exact code location for an issue, don't guess -- suppress the diagnostic entirely rather than highlighting the wrong line. A squiggle on the wrong code is worse than no squiggle at all.

- **Security severity**: When a detection is ambiguous (e.g., parameterized query that *might* have injection), prefer `info` over `warning`. Users who see too many false warnings learn to ignore all warnings.

**The core trust loop**: User sees issue → user fixes code → issue disappears → user trusts the tool. If the middle step breaks (fix code → issue persists or appears on the fix), the entire product value proposition collapses. Every system that touches this loop must prioritize it.

## Build Commands

```bash
# Install dependencies (uses pnpm workspaces)
pnpm install

# Build all packages
pnpm build

# Run CLI in dev mode
pnpm dev

# Initialize a repository
pnpm dev init --path /path/to/repo

# Webview development with hot reload
cd packages/webview && pnpm dev
# Then open http://localhost:5173?repo=/path/to/analyzed/repo
```

### Testing:

```bash
pnpm test              # Run all tests across workspace
pnpm test:watch        # Watch mode (re-runs on change)
cd packages/core && pnpm test   # Single package
```

### Package-specific builds:

```bash
cd packages/core && pnpm build    # TypeScript compiler
cd packages/cli && pnpm build     # TypeScript compiler
cd packages/vscode && pnpm build  # Builds webview first, then extension
cd packages/webview && pnpm build # Vite build
```

## Architecture

### Data Flow

```
Source Code → Language Parser (TS compiler / Python ast / ...) → Function Extraction → Content Hash Check
  → Cache Hit: Skip analysis
  → Cache Miss: Claude AI Analysis → Store by content_hash
→ Local SQLite (locations index) → VS Code Extension → CodeLens + Panels
→ Supabase Sync (analysis entries) → Web UI → Security Dashboard
```

### Package Structure

- **@ophan/core** (`packages/core/src/`): Analysis engine -- pluggable language parsers (`src/parsers/`), Anthropic API, SQLite layer, content-addressed storage
- **@ophan/cli** (`packages/cli/src/index.ts`): Commander-based CLI -- repo analysis orchestration, progress reporting, GC command, sync command
- **ophan** (VS Code extension, `packages/vscode/src/extension.ts`): CodeLens provider, hover tooltips, webview panels, stale detection, sync trigger
- **@ophan/webview** (`packages/webview/src/`): React app -- VS Code mode (postMessage) and browser mode (direct SQLite via `?repo=` URL param)

### Key Architectural Decisions

1. **Per-repo SQLite, gitignored**: DB lives in `.ophan/index.db`, never committed. No PR bloat, no binary merge conflicts. Rebuilt on clone via sync or re-analysis.

2. **Content-addressed storage**: `function_analysis` table uses SHA256 of function source as primary key. Analysis is branch-agnostic -- same function on any branch = same hash = same analysis. Enables insert-only sync with no conflict resolution.

3. **Two-table split**:
   - `function_analysis` (content_hash → analysis JSON) -- synced to Supabase
   - `file_functions` (file_path → content_hash + function_name) -- local only, rebuilt on checkout/pull by scanning files and matching to cache. No line numbers stored -- resolved at runtime via LSP/parser since individual files are small.

4. **Incremental scanning**: Check `file_mtime` in `file_functions` → skip unchanged files entirely → re-parse changed files → re-hash functions → only analyze functions with new hashes

5. **Staleness detection**: File watcher detects edits, marks CodeLens as stale. New hash created on next analysis, old hash becomes orphan in `function_analysis` but never auto-deleted.

6. **Garbage collection**: `ophan gc` -- manual only, never automatic. CLI-side only (Supabase has no code access). Scans codebase, computes current hashes, deletes analysis entries not seen in configurable grace period (default 30 days). This is safe for branch switching: user deletes function on feature branch, switches back to main, analysis is still there. `file_functions` is ephemeral (rebuilt on every scan), `function_analysis` is persistent until explicit GC. If synced to Supabase, GC'd entries can be re-downloaded instead of re-analyzed.

7. **Sync model**: Supabase stores `function_analysis` rows. RLS scopes rows to `user_id`. Sync is insert-only (content-addressed = immutable). On a shared self-hosted server, machines pull existing analysis instead of re-running it.

8. **Single SQLite engine**: The extension host uses `better-sqlite3` (native Node.js) for ALL reads and writes. Every query hits the on-disk file directly -- no stale in-memory snapshots. WAL mode enables concurrent CLI + extension access. sql.js (WebAssembly) is only used in the webview browser dev mode (`packages/webview`, `pnpm dev` at localhost:5173) where native modules aren't available. sql.js must NEVER be used in the extension host -- it loads the entire DB into memory as a snapshot that goes stale immediately, causing persistent bugs with stale start_line values and edit state not propagating.

9. **Webview communication**: Extension <-> Webview via `postMessage` protocol defined in `useVSCode.ts`:
   - Extension sends: `showFunction`, `clear`
   - Webview sends: `ready`, `goToDefinition`, `refresh`

10. **Build output**: Webview builds to `packages/webview/dist/`, then copied to `packages/vscode/webview-dist/` during VS Code extension build.

11. **No encryption**: Analysis is metadata (descriptions, security flags, content hashes), not source code. If someone has the SQLite they already have the source. Supabase auth + RLS handles access control.

12. **Graph is the foundation layer, features consume it independently**: `graph.ts` builds the function relationship graph (edge resolution, transitive edges, storage, centrality) and produces generic primitives (`FunctionEdge`, graphology graph). Community detection (`community-detection.ts`) is one downstream feature that consumes the graph -- it imports from `graph.ts` but `graph.ts` must never import from it. Other downstream features (summarization, visualization, PR impact analysis, team ownership) also consume the graph independently. The CLI orchestrates steps as a two-step pipeline: `buildFunctionGraph()` produces edges, then `detectHierarchicalCommunities()` clusters them. Edge resolvers and community detectors use the registry/strategy pattern for extensibility.

### Database Schema

**Local** (`.ophan/index.db`, gitignored):

```sql
CREATE TABLE function_analysis (
  content_hash TEXT NOT NULL,
  analysis_type TEXT NOT NULL,        -- 'documentation' | 'security' | 'practices'
  analysis JSON NOT NULL,
  model_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,      -- updated on each scan that finds this hash, used by GC grace period
  language TEXT NOT NULL DEFAULT 'typescript',
  entity_type TEXT NOT NULL DEFAULT 'function',
  synced_at INTEGER,
  PRIMARY KEY (content_hash, analysis_type)
);

-- Local file-to-hash mappings (rebuilt on checkout, not synced)
-- No line numbers -- resolved at runtime via LSP/parser
CREATE TABLE file_functions (
  file_path TEXT NOT NULL,
  function_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  file_mtime INTEGER NOT NULL,
  language TEXT NOT NULL DEFAULT 'typescript',
  entity_type TEXT NOT NULL DEFAULT 'function'
);
```

```sql
-- Local cache of practices (managed in webapp, pulled during sync)
CREATE TABLE practices (
  practice_id TEXT PRIMARY KEY,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning'
);
```

Analysis JSON shapes per `analysis_type`:
- **documentation**: `{ description, params: [{name, type, description}], returns: {type, description} }`
- **security** (v2): `{ dataTags: string[], securityFlags: string[], issues: DetailedIssue[] }`
  - `DetailedIssue`: `{ flag, title, description, explanation, line, startText, endText, severity }`
  - `SCHEMA_VERSIONS.security = 2`. v1 rows (no `issues` field) default to `issues: []` via `.catch([])`.
- **practices**: `{ violations: DetailedIssue[] }` -- team-defined coding practice violations

**Supabase** (cloud):

```sql
CREATE TABLE function_analysis (
  content_hash TEXT NOT NULL,
  analysis_type TEXT NOT NULL,
  repo_id UUID NOT NULL,
  user_id UUID NOT NULL,
  analysis JSONB NOT NULL,
  model_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  -- ... generated columns, timestamps ...
  PRIMARY KEY (content_hash, repo_id, analysis_type)
);

-- Repo-scoped coding practices (managed via webapp settings)
CREATE TABLE repo_practices (
  id UUID PRIMARY KEY,
  repo_id UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  practice_id TEXT NOT NULL,     -- kebab-case identifier
  rule TEXT NOT NULL,            -- max 200 chars
  severity TEXT NOT NULL DEFAULT 'warning',
  UNIQUE (repo_id, practice_id)
);
```

Location: `.ophan/index.db` in analyzed repository root. Added to `.gitignore`.

## Environment

Requires `ANTHROPIC_API_KEY` in environment (via `.env` file in repo root, or user's own key in extension settings for BYOK). `OPHAN_MODEL` overrides the Claude model (default `claude-sonnet-5-5`, set in `core/src/claude.ts`, the only module that calls the Anthropic API). Self-hosted server config is resolved at runtime by `cli/src/server.ts`; nothing is baked into builds.

## Coding Standards

- **Module structure**: Use direct imports for internal app code. Barrel exports (`index.ts` re-exports) are reserved for package boundaries (e.g., `@ophan/core/schemas`). Avoid adding new internal barrel files -- they hurt tree-shaking and create circular dependency risk.
- **Imports**: Use `import type` for type-only imports. Prefer named exports over default exports.
- **Strict TypeScript**: Avoid `any` at API boundaries. Use discriminated unions (e.g., `TypedAnalysis`) over type assertions. The `context as any` pattern in TanStack Start server functions is a known exception until middleware types improve.
- **Pure utilities**: Keep business logic in pure functions (e.g., `api/merge.ts`) separate from framework-specific code (server functions, React hooks, components). This enables reuse and testing.
- **Component architecture**: Build small, focused components. Separate data (fetching, state, filtering) from presentation. Page-level components own data; visual components are prop-driven and reusable. Lift state up to enable reuse -- a card component should receive its data as props, not fetch it internally. When composing Radix primitives (e.g., Tooltip + Badge), use `asChild` to avoid wrapper elements that break layout -- never add intermediate `<span>` wrappers. Always use shadcn/Radix UI components over native browser elements (e.g., shadcn Select over `<select>`, Button toggles over `<input type="checkbox">`). This ensures consistent styling and rendering control across browsers.
- **Schemas as source of truth**: Zod schemas in `@ophan/core/schemas` are the single source of truth for analysis data shapes. Consumers import types from there -- never redefine `DocumentationAnalysis`, `SecurityAnalysis`, etc.
- **Open with known values**: Enum-like fields (security flags, data tags) use `z.string()` arrays, not `z.enum()`. Known values in `KNOWN_SECURITY_FLAGS` / `KNOWN_DATA_TAGS` exist for prompting Claude and providing display labels -- not for validation. UI uses `LABELS[value] ?? value` for display.
- **Testing**: Tests must pass before changes are considered complete. New business logic must have corresponding tests. Changed logic requires updated tests. Test our logic, not library behavior. See `docs/testing.md` for philosophy, patterns, and utilities. Build code in testable ways: pure functions, dependency injection, avoid hidden state.
- **TanStack Start server functions**: Use `createServerFn().inputValidator(...)` -- NOT `.validator(...)`. The `.validator()` API was renamed to `.inputValidator()` in the current version. See existing server functions in `packages/webapp/src/services/api/` for the correct pattern.
- **Schema evolution**: When changing analysis JSON shape, bump `SCHEMA_VERSIONS` in `schemas.ts` and add `.catch()` default in the Zod schema. Old rows get re-analyzed incrementally on next scan. When adding tables/columns, add a core migration in `migrations.ts` and update `createFreshSchema()`. See `docs/architecture/migrations.md` for the full decision tree.
- **Performance & UX**: Fast is good user experience. External API calls (Claude, Supabase) must use bounded concurrency (`p-limit`) -- never `await` in a sequential loop when calls are independent. Every user-facing operation longer than 1 second must report progress. See `.claude/skills/ux-performance/SKILL.md`.

## On Every Task Completed

- you must add valid and correct tests for core and critical features and logic
- you must update the relevant docs in `docs/`: user guides (`getting-started.md`, `extension.md`, `cli.md`, `self-hosting.md`, ...) and the technical docs in `docs/architecture/`
- you must create or update relevant skills in `.claude/skills/` (see Skills Maintenance below)

## Skills Maintenance

Skills (`.claude/skills/*/SKILL.md`) are living documentation of complex systems, patterns, and techniques in this codebase. They give Claude Code deep context on demand, reducing errors and improving output quality on intricate work.

### When to Create a New Skill

Create a new skill when you encounter or build:
- A complex subsystem with non-obvious design decisions (e.g., sync semantics, community detection)
- A novel algorithm or technique not standard in the ecosystem (e.g., cross-cutting concern detection via centrality analysis)
- An external library with unstable/evolving APIs where correct usage matters (e.g., TanStack Start)
- An authentication or security flow with subtle invariants (e.g., separate token chains for CLI)
- A cross-package pattern that multiple areas of the codebase depend on (e.g., content-addressed storage)

### When to Update an Existing Skill

Update a skill whenever you:
- Change a system the skill documents (new fields, renamed APIs, changed flow)
- Fix a bug that reveals a missing invariant or edge case the skill should capture
- Add a new pattern or technique to an existing system
- Discover that a skill is incomplete or misleading during development

### Skill Writing Standards

- **Description field is critical:** Write a clear, specific description that tells Claude exactly when to load the skill. Bad: "helpful coding tips". Good: "SQLite local ↔ Supabase cloud sync system. Use when working on sync logic, push/pull flows, GC tombstones, or any code touching synced_at fields."
- **Include key files:** Always list the primary source files at the bottom so Claude knows where to look.
- **Document invariants, not just behavior:** Capture the "why" -- design decisions, edge cases, things that would break if done differently.
- **Keep under 500 lines:** Use supporting files (`reference.md`, `examples.md`) for additional detail if needed.
- **Use concrete examples:** Show actual function signatures, SQL schemas, and code patterns from the codebase.

### Current Skills

| Skill | System | Key Files |
|-------|--------|-----------|
| `sync-system` | SQLite ↔ Supabase sync, push/pull, GC tombstones | `cli/src/sync.ts`, `core/src/index.ts` |
| `function-parsing` | Language parsers, AST extraction, parser registry | `core/src/parsers/*.ts` |
| `cli-auth` | Magic link auth, separate token chains, refresh | `cli/src/auth.ts` |
| `webapp-auth` | Supabase SSR, middleware, route protection | `webapp/src/middleware/*.ts` |
| `tanstack-start` | Correct API usage, server functions, routes | `webapp/src/services/api/*.ts` |
| `graph-system` | Edge types, graph building, centrality (foundation layer) | `core/src/graph.ts` |
| `community-finding` | Community detection, L1-L3 summarization, cross-cutting concerns | `core/src/community-detection.ts`, `core/src/summarize.ts` |
| `testing` | Test philosophy, utilities, patterns per package | `core/src/test-utils.ts` |
| `schema-system` | Zod schemas, open-with-known-values, analysis types | `core/src/schemas.ts` |
| `vscode-extension` | CodeLens, webview protocol, better-sqlite3, query extraction | `vscode/src/extension.ts` |
| `content-addressing` | SHA256 hashing, incremental scanning, cache flow, GC | `core/src/shared.ts` |

