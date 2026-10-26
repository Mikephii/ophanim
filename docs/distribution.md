# Distribution

How Ophan reaches users, and a proposal for bundling the CLI into the extension.

**Today:** the extension is published per platform with prebuilt `better-sqlite3` binaries for several Electron ABIs (see [native-binary-bundling.md](release-lifecycle/native-binary-bundling.md)), and runs analysis by spawning `npx @ophan/cli`. The "Target State" below is not implemented yet.

## Extension-First

Ophan's primary distribution channel is the **VS Code extension**. The extension bundles the analysis engine (CLI + core) internally so users never need to install an npm package.

### Why Extension-First

1. **Language-agnostic** -- Python, Go, Java, and Ruby projects don't have `package.json`. Requiring `npm install` would shut out non-Node projects. The extension works in any workspace.

2. **Zero-friction onboarding** -- Install extension, set API key in settings, click "Analyze". No terminal commands, no package manager, no `.env` file juggling.

3. **Enterprise-friendly** -- IT teams deploy extensions via VS Code policies. No npm registry access required. No supply chain concerns from adding a dev dependency.

4. **Simpler mental model** -- One thing to install, one thing to update. Extension auto-updates via the marketplace.

5. **Not coupled to project config** -- Analysis is a developer tool, not a build dependency. It shouldn't live in `package.json` next to React and Express.

### Two Distribution Channels

| | VS Code Extension (Primary) | CLI npm Package (Secondary) |
|---|---|---|
| **Audience** | Individual developers, teams | CI/CD pipelines, GitHub Actions, scripting |
| **Install** | VS Code Marketplace | `npm install -g @ophan/cli` or `npx @ophan/cli` |
| **API key** | VS Code settings or workspace `.env` | Environment variable or `.env` file |
| **Trigger** | Click "Analyze Now" or auto on save | `ophan analyze` command |
| **Use case** | Day-to-day development, inline results | Automated analysis in CI, headless environments |
| **Output** | CodeLens, hover tooltips, panels | `.ophan/index.db` (read by extension or web UI) |

Both channels produce the same `.ophan/index.db` SQLite file. The extension reads it for inline display. The CLI writes it during analysis.

## How Bundling Works

### Current State

The extension shells out to the CLI via npx:

```typescript
// packages/vscode/src/extension.ts (resolveCliCommand / startWatchMode)
watchProcess = spawn("npx", ["@ophan/cli", "watch", "--json", "--path", workspaceRoot], ...);
```

This needs Node.js on the user's PATH, and npm access the first time (npx downloads the CLI).

### Target State

The compiled CLI is bundled inside the VSIX package:

```typescript
// Target implementation
const cliPath = path.join(context.extensionPath, "cli", "dist", "index.js");
analyzeProcess = execFile(process.execPath, [cliPath, "analyze", "--path", workspaceRoot], ...);
```

The CLI runs as a subprocess (same as today) but uses the bundled copy instead of npx. No external dependency.

### Extension Dependency Chain

```
VS Code Extension (VSIX)
  ├── better-sqlite3 (native, per-ABI binaries in native/)
  ├── webview-dist/ (React UI, built by Vite)
  └── cli/ (bundled analysis engine)
      ├── @ophan/core
      │   ├── @anthropic-ai/sdk (Claude API)
      │   ├── better-sqlite3 (native SQLite, for writing .ophan/index.db)
      │   ├── parsers/ (TypeScript compiler API, Python ast subprocess)
      │   └── zod (schema validation)
      └── commander, dotenv, @supabase/supabase-js
```

### Build Changes Required

1. **esbuild bundle**: Bundle the CLI into a single JS file to avoid shipping `node_modules/` inside the VSIX. Most dependencies bundle cleanly. better-sqlite3 is a native addon and needs special handling.

2. **Native module strategy**: `better-sqlite3` requires platform-specific compiled binaries. Options:
   - Ship prebuilt binaries for darwin-arm64, darwin-x64, linux-x64, win32-x64
   - Use `@aspect-build/better-sqlite3` which includes prebuilds
   - Consider switching the CLI's write path to sql.js (same as extension's read path) -- trades write performance for simpler bundling

3. **VSIX size**: Expected ~5-10MB (currently ~500KB). Acceptable for a bundled tool.

4. **Build script**: `packages/vscode/package.json` build needs to: compile CLI → bundle with esbuild → copy into extension directory → `vsce package`.

## API Key Management

| Source | Extension | CLI |
|--------|-----------|-----|
| VS Code settings | `ophan.anthropicApiKey` | N/A |
| Workspace `.env` | Falls back to this | Primary |
| System env var | Falls back to this | Falls back to this |

The extension checks VS Code settings first, then workspace `.env`, then system environment. The CLI checks `.env` then system environment.

## Trade-offs

### Advantages of Bundling

- Users install one thing, not two
- Works in non-Node projects
- No version mismatch between extension and CLI
- Enterprise deployment via extension policies
- Offline-capable (no npx registry lookups)

### Costs of Bundling

- VSIX size increases significantly
- Extension updates include CLI updates (can't version independently)
- Native module (better-sqlite3) complicates cross-platform VSIX builds
- Still need to publish CLI separately for CI/CD users -- two release artifacts
- Extension marketplace review process adds latency to CLI bug fixes

### Why Not Extension-Only (No CLI)

The CLI must exist as a standalone package for:
- **CI/CD**: GitHub Actions, GitLab CI, Jenkins -- no VS Code available
- **Scripting**: `ophan analyze && ophan sync` in shell scripts
- **Other IDEs**: JetBrains, Neovim plugins would use CLI output
- **Headless servers**: Remote analysis on build machines

## Watch Mode Integration

The extension uses `ophan watch --json --sync` as a long-running background subprocess. This provides:

- **Auto-analysis on save**: Watch detects file changes, debounces (5s), and re-analyzes
- **Auto-sync**: After each analysis batch, pushes new results to cloud (10s debounce)
- **Cloud pull**: During analysis, pulls existing results from cloud before calling Claude
- **JSON events**: Structured event stream for real-time UI updates

### Watch Event Flow

```
Extension spawns: ophan watch --json --sync --path <workspace>
  │
  ├── scan_complete → Extension loads DB, shows CodeLens
  ├── analyzing     → Status bar: "Analyzing src/foo.ts..."
  ├── analyzed      → DB watcher reloads, CodeLens refreshes
  ├── synced        → Logged to output channel
  └── error         → Output channel; API key errors → toast with settings link
```

### Lifecycle

- **Start**: On activation (if DB exists + API key set + autoAnalyze enabled)
- **Start**: After "Analyze Now" (creates DB if first run)
- **Restart**: On API key change, or autoAnalyze/autoSync settings change
- **Stop**: On extension deactivation
- **Not started**: If no API key (read-only mode), or autoAnalyze disabled

### Initialization UX States

| State | Status Bar | Action |
|-------|-----------|--------|
| No API key, no DB | "Setup needed" | Toast: "Set your API key" + [Open Settings] |
| Has API key, no DB | "Ready" | Toast: "Analyze this workspace?" + [Analyze Now] |
| Has API key, has DB | "Ophan" | Silent -- loads DB, starts watch |
| No API key, has DB | "Ophan" | Read-only mode -- shows existing analysis |

### .gitignore Auto-Entry

`analyzeRepository()` in core automatically adds `.ophan/` to `.gitignore` (or creates one in git repos). Users never need to manually configure this.
