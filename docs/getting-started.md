# Getting started

Ophan finds security problems in your code and documents every function, using Claude. It runs on your machine with your own Anthropic API key and keeps results in a local SQLite file in each repo.

You can use it two ways, and they share the same results:

- **In VS Code** (and Cursor, Windsurf, VSCodium): findings appear as squiggles on the vulnerable line, with CodeLens and a dashboard panel. See [extension.md](extension.md).
- **From the terminal**: `npx @ophan/cli`. Works with any editor and in CI. See [cli.md](cli.md).

## What you get

- **Security findings** per function: SQL injection, XSS, hardcoded secrets, command injection, path traversal, unsafe eval and deserialization, and more, each with an explanation and a fix. See [security-analysis.md](security-analysis.md).
- **Data flow tags**: which functions touch user input, PII, credentials, the database, the file system or external APIs.
- **Function docs**: a description, parameters and return value for every function.
- **Architecture docs** (optional): `ophan graph --summarize` clusters related functions and writes docs for each subsystem.

Supported languages: TypeScript, JavaScript and Python.

## In VS Code

1. Install **Ophan** from the Marketplace or Open VSX (or another way in [extension.md](extension.md#install)). Node.js must be on your PATH.
2. Set your Anthropic API key: **Settings → Ophan → Anthropic Api Key**, or `ANTHROPIC_API_KEY`.
3. Click **Analyze Now** when prompted.

## In the terminal

Requires Node.js 20 or newer.

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or put it in a .env file in the repo
cd your-project
npx @ophan/cli init      # index functions; fast, no network calls
npx @ophan/cli analyze   # analyze everything once
npx @ophan/cli watch     # or: analyze, then re-analyze on every save
```

Results land in `.ophan/index.db`, which `init` adds to `.gitignore`.

## How it works

1. A native parser (the TypeScript compiler, Python's `ast`) extracts every function.
2. Each function is identified by the SHA256 of its source code.
3. Functions whose hash is already in `.ophan/index.db` are skipped. The rest go to Claude, a file at a time.
4. Results are stored by hash, so they survive branch switches, renames and moves, and are never paid for twice.

Editing a function changes its hash, so only that function is re-analyzed on the next save.

## Costs

Analysis uses your Anthropic API key and is billed to your account. The first run sends every function once; after that, only changed functions are sent. See the README for a measured example.

## Optional: your own server

To sync analysis across machines and use the web dashboard, run your own Ophan server: [self-hosting.md](self-hosting.md). Nothing else needs it.
