# @ophan/webview

React-based UI for displaying function analysis in VS Code panels and standalone browser.

## Modes

### VS Code Mode
Runs in sandboxed iframe within VS Code. Communication via postMessage:
- Extension sends function data to display (`showFunction`, `clear`)
- Webview sends navigation/action requests back (`ready`, `goToDefinition`, `refresh`)

### Browser Mode
Standalone development at `localhost:5173`. Loads SQLite DB directly via `?repo=` URL param. Hot module replacement for fast iteration.

## What It Displays

- Function metadata (name, location, signature)
- Documentation (AI-generated description, parameters, returns)
- Security analysis (vulnerability flags, severity, explanations)
- Data flow classifications (PII, credentials, external APIs, database access)
- Staleness indicators (function edited since last analysis)
- Action buttons (navigate to source, refresh analysis)

## Development

```bash
cd packages/webview
pnpm dev
# Open http://localhost:5173?repo=/path/to/analyzed/repo
```

### Browser development (recommended)
- Vite dev server with HMR
- Chrome DevTools available
- No VS Code rebuild needed
- Mock or real data via SQLite query param

### VS Code integration testing
1. `pnpm build` in webview package
2. `pnpm build` in vscode package (copies webview dist)
3. Launch extension in dev mode
4. Debug via webview developer tools (right-click panel)

## Build

- **Dev**: HMR, source maps, relaxed CSP
- **Production**: Minified JS, optimized CSS, fixed asset filenames for extension bundling, strict CSP

## Architecture Decisions

### Dual-Mode Design
The webview runs in two environments with the same React components but different data sources:
- **VS Code mode**: Data arrives via postMessage from the extension host. No direct DB access.
- **Browser mode**: Loads .ophan/index.db via HTTP using sql.js (WebAssembly SQLite).

This enables fast iteration -- webview development uses `pnpm dev` with hot reload at localhost:5173, no VS Code rebuild needed. The `FunctionData` interface is the canonical data shape shared across both modes.

### IDE Adapter Future
The `useVSCode.ts` hook is tightly coupled to VS Code's `acquireVsCodeApi` / `postMessage` protocol. To support JetBrains (JCEF), Neovim, or other IDEs, the communication layer will be abstracted behind an `IDEAdapter` interface:
- Each IDE provides its own adapter (VS Code postMessage, JetBrains action bridge, HTTP for browser)
- The React components and data shapes remain unchanged
- Only the transport mechanism changes

### Language & Entity Type Display
`FunctionData` carries `language` and `entityType` fields from the database. The detail view shows a language badge (e.g., "typescript") and entity type badge when not "function" (e.g., "method"). This prepares the UI for multi-language analysis without requiring component changes later.

## Styling

Respects VS Code theme via CSS variables. Matches editor appearance across light/dark themes.
