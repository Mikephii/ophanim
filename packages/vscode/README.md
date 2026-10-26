# Ophan for VS Code

Find security vulnerabilities in your code before they reach production.

Ophan scans every function in your codebase using AI and gives you results right where you write code -- no context switching, no separate dashboards to check.

## What It Does

- **Security scanning** -- finds SQL injection, XSS, hardcoded secrets, path traversal, command injection, and more
- **Data flow tracking** -- shows which functions handle user input, PII, credentials, and sensitive data
- **Inline documentation** -- every function gets a plain-English description, parameter docs, and return type docs

All results appear inline in your editor as you work.

## Getting Started

1. Install the extension from the VS Code Marketplace or Open VSX (Cursor, Windsurf, VSCodium). Ophan needs Node.js on your PATH.
2. Add your Anthropic API key in VS Code Settings (search "Ophan"), or set `ANTHROPIC_API_KEY`
3. Click "Analyze Now" when prompted

That's it. Ophan parses your code, runs analysis, and starts showing results immediately. After the first run, it watches for file saves and re-analyzes only what changed.

## How You See Results

**CodeLens annotations** -- a one-liner above each function with its description, security warnings, and data flow tags. Click to expand.

**Hover tooltips** -- hover any function name for a quick summary of parameters, return type, and flags.

**Detail panel** -- click any annotation to open the full breakdown: documentation, security explanations, data flow classifications, and a link back to the source.

## Cloud Sync (optional, self-hosted)

Analysis is stored locally and needs no account. If you run your own Ophan server, set `ophan.serverUrl` and run **Ophan: Sign In** to sync analysis across machines and open the web dashboard. See the [self-hosting guide](https://github.com/Mikephii/ophanim/blob/main/docs/self-hosting.md).

## Supported Languages

- TypeScript / JavaScript
- Python

## Links

- [Source and documentation](https://github.com/Mikephii/ophanim)
- [Extension guide](https://github.com/Mikephii/ophanim/blob/main/docs/extension.md)
- [CLI for CI/CD](https://github.com/Mikephii/ophanim/blob/main/docs/cli.md)
- [Security analysis](https://github.com/Mikephii/ophanim/blob/main/docs/security-analysis.md)
- [Self-hosting](https://github.com/Mikephii/ophanim/blob/main/docs/self-hosting.md)
- [Report an issue](https://github.com/Mikephii/ophanim/issues)
