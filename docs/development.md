# Development Setup

## Prerequisites

- Node.js 24 (20 is the minimum the CLI supports; the repo is developed on 24)
- pnpm 10.11 (`corepack enable` picks the version from `package.json`)
- A C++ toolchain and Python 3 (to build `better-sqlite3`; Xcode Command Line Tools on macOS, `build-essential` on Debian/Ubuntu)
- Docker (for local Supabase and the demo rig)
- [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started) (for local backend)
- Python 3 is also what the Python parser runs on

## Install Dependencies

```bash
pnpm install
```

## Local Supabase

```bash
supabase start      # from the repo root
```

This starts a local Supabase instance with Postgres, Auth, and Studio. Note the output -- it shows the local URLs and keys.

## Environment Configuration

```bash
cp .env.example .env                                     # ANTHROPIC_API_KEY for the CLI
cp packages/webapp/.env.example packages/webapp/.env     # fill in from `supabase status`
```

The webapp reads its Supabase settings at runtime (see [webapp auth](architecture/webapp-auth.md)); nothing is baked into builds.

## Running the Web App

```bash
cd packages/webapp
pnpm dev
```

Opens at [http://localhost:3000](http://localhost:3000). Create a test account via the sign-up page (local Supabase auto-confirms emails, no SMTP needed).

## CLI Development

```bash
# Analyze a repository
pnpm dev analyze --path /path/to/repo

# Sign in to the local webapp (for sync testing); saved to ~/.ophan/config.json
pnpm dev login --server http://localhost:3000

# Sync to local Supabase
pnpm dev sync --path /path/to/repo
```

## Build Commands

```bash
pnpm build                # Build all packages
pnpm dev                  # CLI in dev mode
```

### Package-Specific Builds

```bash
cd packages/core && pnpm build    # TypeScript compiler
cd packages/cli && pnpm build     # TypeScript compiler
cd packages/vscode && pnpm build  # Builds webview first, then extension
cd packages/webview && pnpm build # Vite build
cd packages/webapp && pnpm build  # TanStack Start build
```

## Webview Development

```bash
cd packages/webview && pnpm dev
```

Opens at [http://localhost:5173](http://localhost:5173). Pass `?repo=/path/to/analyzed/repo` to load a database in browser mode.

## Testing

```bash
pnpm test              # All tests across workspace
pnpm test:watch        # Watch mode (re-runs on change)

# Single package
cd packages/core && pnpm test
cd packages/cli && pnpm test
cd packages/webapp && pnpm test

# Single file
pnpm vitest run packages/core/src/index.test.ts
```

See [testing.md](testing.md) for test philosophy, utilities, and patterns.

## Verify in Supabase Studio

Open [http://localhost:54323](http://localhost:54323) (Supabase Studio) and check the Table Editor:

- `repos` -- your repository entry
- `function_analysis` -- synced analysis data
- `function_locations` -- file-to-function mappings

## Package Structure

| Package | Path | Runtime |
|---------|------|---------|
| @ophan/core | `packages/core/` | Node.js (better-sqlite3) |
| @ophan/cli | `packages/cli/` | Node.js |
| ophan (VS Code) | `packages/vscode/` | Electron extension host (better-sqlite3, per-ABI binaries) |
| @ophan/webview | `packages/webview/` | Browser (React + sql.js) |
| ophan-webapp | `packages/webapp/` | TanStack Start + Supabase |

## Extension development

```bash
pnpm build
code --extensionDevelopmentPath="$PWD/packages/vscode" /path/to/a/test/repo
```

This opens an Extension Development Host running your build. In development the extension runs the workspace CLI build (`packages/cli/dist`), so run `pnpm --filter @ophan/cli build` after changing the CLI or core. To install a packaged build into your own editor, run `pnpm vs:sideload`.

See [distribution.md](distribution.md) for how the extension and CLI are packaged.
