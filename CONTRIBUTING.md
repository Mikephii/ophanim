# Contributing to Ophan

Thanks for helping. Bug reports, ideas, docs fixes and code are all welcome.

- **Bugs and ideas**: open an [issue](https://github.com/Mikephii/ophanim/issues). For anything bigger than a small fix, please open an issue before the pull request so we can agree on the approach.
- **Security vulnerabilities in Ophan itself**: don't open an issue; see [SECURITY.md](SECURITY.md).
- **A finding Ophan got wrong** (a false positive or a missed vulnerability) is a normal bug: open an issue with the code (or a minimal version of it) and what you expected.

## Prerequisites

- **Node.js 24** (the CLI supports 20+, the repo is developed and tested on 24)
- **pnpm 10.11**: `corepack enable` and the version in `package.json` is picked up
- **A C++ toolchain and Python 3**, to compile `better-sqlite3`: Xcode Command Line Tools on macOS, `build-essential` on Debian/Ubuntu, Visual Studio Build Tools on Windows. Python 3 is also what the Python parser runs on.
- **Docker**, for a local Supabase (only needed for sync and webapp work) and the demo recording rig
- An **Anthropic API key**, for anything that runs real analysis (tests don't need one)

## Setup

```bash
git clone https://github.com/Mikephii/ophanim.git && cd ophanim
pnpm install
pnpm build
pnpm test
cp .env.example .env    # add ANTHROPIC_API_KEY to try the CLI
```

## Repository layout

| Path | What |
|---|---|
| `packages/core` | Analysis engine: parsers (`src/parsers/`), content hashing, SQLite schema and migrations, Claude calls (`src/claude.ts`), function graph and community detection |
| `packages/cli` | `@ophan/cli`: commands, watch mode, sync, server config (`src/server.ts`) |
| `packages/vscode` | The extension: diagnostics, CodeLens, hovers, watch process, webview host |
| `packages/webview` | React panel shown in the extension (also runs in a browser against a local DB) |
| `packages/webapp` | Self-hosted dashboard and sync server (TanStack Start + Supabase) |
| `supabase/` | Server schema: migrations and local config |
| `deploy/` | Docker Compose and Caddy examples for self-hosting |
| `demo/` | Sample app and the recording rig for the README videos |
| `docs/` | User guides and `docs/architecture/` design docs |
| `.claude/skills/` | Deep notes on each subsystem, written for AI coding agents and just as useful for people |

## Dev loops

```bash
# CLI against any repo (uses .env for ANTHROPIC_API_KEY)
pnpm dev analyze --path /path/to/repo
pnpm dev watch --path /path/to/repo

# Webview with hot reload, reading a repo's .ophan/index.db
cd packages/webview && pnpm dev     # http://localhost:5173?repo=/path/to/analyzed/repo

# Extension in a development host
pnpm build
code --extensionDevelopmentPath="$PWD/packages/vscode" /path/to/repo

# Package and install the extension into your own editor
pnpm vs:sideload

# Webapp against a local Supabase
supabase start
cp packages/webapp/.env.example packages/webapp/.env   # fill in from `supabase status`
cd packages/webapp && pnpm dev                         # http://localhost:3000
```

More detail in [docs/development.md](docs/development.md).

## Tests and checks

```bash
pnpm test                       # every package
cd packages/core && pnpm test   # one package
pnpm typecheck                  # every package
```

Tests must pass and typecheck must be clean before a PR is merged; CI runs both, plus a secret scan. New logic needs tests, and changed logic needs updated tests. Test our behaviour, not the libraries'. See [docs/testing.md](docs/testing.md) for the philosophy and helpers.

## Standards

The full list is in [CLAUDE.md](CLAUDE.md) (also linked as `AGENTS.md`); the short version:

- **False negatives over false positives.** When unsure, under-report: suppress a squiggle rather than put it on the wrong line, prefer `info` to `warning`. The fix-and-it-disappears loop is the product; don't break it.
- **Schemas are the source of truth.** Analysis shapes live in `@ophan/core/schemas` (Zod). When an analysis shape changes, bump `SCHEMA_VERSIONS` and add a `.catch()` default; when tables change, add a migration. See [docs/architecture/migrations.md](docs/architecture/migrations.md). Server schema changes are new files in `supabase/migrations/`, never edits to old ones.
- **Strict TypeScript**, named exports, `import type` for types, no `any` at API boundaries.
- **Small, pure functions** for logic, kept apart from framework glue so they can be tested.
- **Bounded concurrency** (`p-limit`) for API calls, and progress for anything slower than a second.
- **Comments explain why**, not what.

## Docs and skills

If you change behaviour users can see, update the guide in `docs/`. If you change how a subsystem works, update its doc in `docs/architecture/` and its notes in `.claude/skills/<system>/SKILL.md`. Those skills are how AI coding agents (and new contributors) learn the codebase quickly, so stale ones cause real bugs.

## Pull requests

- One logical change per PR, with a description of what and why, and how you tested it.
- Screenshots or a short clip for UI changes.
- Keep commits readable; we squash on merge.
- By contributing, you agree your contribution is licensed under the [MIT License](LICENSE), like the rest of the project. There is no CLA.

## Releases

Maintainers cut releases; see [docs/releasing.md](docs/releasing.md).
