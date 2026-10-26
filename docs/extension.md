# The VS Code extension

The Ophan extension shows security findings, data flows and generated docs right in the editor: squiggles on the vulnerable line, CodeLens above each function, hovers, and a panel for browsing everything. It works in VS Code and in editors built on it (Cursor, Windsurf, VSCodium, Antigravity).

## Install

Pick whichever fits your editor.

### 1. VS Code Marketplace

Search **Ophan** in the Extensions view, or:

```bash
code --install-extension ophan.ophan
```

### 2. Open VSX (Cursor, Windsurf, VSCodium, ...)

Editors that can't use Microsoft's marketplace install from [Open VSX](https://open-vsx.org). Search **Ophan** in their Extensions view; it's the same extension.

### 3. VSIX from GitHub Releases

Every [release](https://github.com/Mikephii/ophanim/releases) attaches one `.vsix` per platform, because each bundles a native SQLite module:

| Your machine | File |
|---|---|
| macOS, Apple Silicon | `ophan-darwin-arm64-<version>.vsix` |
| macOS, Intel | `ophan-darwin-x64-<version>.vsix` |
| Linux x64 | `ophan-linux-x64-<version>.vsix` |
| Linux ARM64 | `ophan-linux-arm64-<version>.vsix` |
| Windows x64 | `ophan-win32-x64-<version>.vsix` |
| Windows ARM64 | `ophan-win32-arm64-<version>.vsix` |

```bash
code --install-extension ophan-darwin-arm64-0.1.0.vsix
# Cursor: cursor --install-extension ...   Windsurf: windsurf --install-extension ...
```

Or drag the file onto the Extensions view, or use **Extensions: Install from VSIX...** in the Command Palette.

### 4. Build from source

Needs the [contributor prerequisites](../CONTRIBUTING.md#prerequisites) (Node 24, pnpm, a C++ toolchain).

```bash
git clone https://github.com/Mikephii/ophanim.git && cd ophanim
pnpm install
pnpm build
pnpm vs:sideload   # builds native modules, packages ophan-local.vsix, installs it into `code`
```

Reload the window afterwards. For other editors, install `packages/vscode/ophan-local.vsix` with their own CLI.

## Requirements

- **Node.js on your PATH.** The extension runs the Ophan CLI with `npx @ophan/cli` for analysis, so it needs `node` and `npx`. The first run downloads the CLI from npm.
- **An Anthropic API key.** Analysis calls Claude with your key. Get one at [console.anthropic.com](https://console.anthropic.com).

## Set your API key

Either:

- **Settings → Ophan → Anthropic Api Key** (`ophan.anthropicApiKey`). Stored in your VS Code user settings, in plain text, like any setting.
- Or set `ANTHROPIC_API_KEY` in the environment VS Code starts from. The setting wins when both are set.

Then click **Analyze Now** in the prompt (or run **Ophan: Analyze Now**). The first run analyzes every function; after that, Ophan watches for saves and only re-analyzes functions whose code changed.

## What you see

- **Squiggles and gutter shields** on the exact line of each finding (red for errors, yellow for warnings, blue for info), also listed in the Problems panel (`Cmd+Shift+M`).
- **Hover** a squiggle for the finding's title and explanation; **Quick Fix** (`Cmd+.`) offers **View in Ophan**.
- **CodeLens** above every function: a one-line description, security flags and data tags. Click it to open the function in the Ophan panel.
- **The fix loop.** Edit the flagged line and its squiggle disappears immediately. Watch mode re-analyzes within seconds: if the issue is really fixed it stays gone, if not it comes back on the right line.
- **The Ophan panel** (**Ophan: Open**):
  - **Security dashboard**: posture, counts by severity, top issues, issues by category
  - **Issues**: filter by flag or severity, dismiss false positives or accepted risks (with a reason)
  - **Functions**: search everything analyzed; open a function for its docs, findings and data flow tags
  - **Architecture** and **Graph**: generated architecture docs and the function graph (after `ophan graph --summarize`)
  - **Learn**: what each vulnerability type is, with vulnerable and safe examples

## Commands

| Command | What it does |
|---|---|
| **Ophan: Analyze Now** | Analyze the workspace now (starts watch mode) |
| **Ophan: Open** | Open the Ophan panel |
| **Ophan: View Function Details** | Open the panel on a function (used by CodeLens and hovers) |
| **Ophan: View Status** | Show analysis status and errors |
| **Ophan: Control Panel** | The status bar menu: analyze, open panel, settings |
| **Ophan: Sign In** | Sign in to your self-hosted Ophan server (needs `ophan.serverUrl`) |

## Settings

| Setting | Default | Description |
|---|---|---|
| `ophan.anthropicApiKey` | `""` | Your Anthropic API key. Falls back to `ANTHROPIC_API_KEY`. |
| `ophan.autoAnalyze` | `true` | Re-analyze changed files on save (watch mode) |
| `ophan.serverUrl` | `""` | Your self-hosted Ophan server. Empty keeps everything local: no sign-in prompt, no sync. |
| `ophan.autoSync` | `true` | Sync after each analysis batch. Only applies when `ophan.serverUrl` is set and you're signed in. |
| `ophan.showDiagnostics` | `true` | Show findings as squiggles and in the Problems panel |
| `ophan.showGutterIcons` | `true` | Show shield icons in the gutter next to findings |

To use a different Claude model, set `OPHAN_MODEL` in the environment VS Code starts from (default `claude-sonnet-5-5`).

## Where data lives

Everything is in `.ophan/index.db` at the workspace root (added to `.gitignore` for you): analysis, dismissed issues and edit tracking. The CLI and the extension share it, so analysis done in a terminal shows up in the editor and the other way round. Nothing leaves your machine except function source sent to the Anthropic API for analysis, and, only if you configure a server, analysis results synced to it. See [self-hosting.md](self-hosting.md).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `NODE_MODULE_VERSION` or "native module" errors | The bundled SQLite module doesn't match your editor's Electron version. Install the VSIX for your platform from the latest release. Supported Electron ABIs are listed in `packages/vscode/scripts/build-native.sh`; open an issue with your editor and version if yours is missing. |
| `npx: command not found`, or analysis never starts | Install Node.js and make sure VS Code sees it on PATH (on macOS, start VS Code from a terminal with `code .` to inherit your shell's PATH). Check **Ophan: View Status** and the **Ophan** output channel. |
| Squiggles don't update after edits | Check `ophan.autoAnalyze` is on and the status bar shows Ophan watching. Only one watcher runs per repo (`.ophan/watch.lock`); close other editors or CLIs watching the same folder. |
| "Claude declined to analyze this code" | The model refused that file. Other files still analyze; try again later or with another `OPHAN_MODEL`. |
| No sign-in prompt | Expected without `ophan.serverUrl`. Ophan doesn't need an account. |
