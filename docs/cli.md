# The CLI

`@ophan/cli` runs Ophan from any terminal: analysis, watch mode, the function graph and architecture docs, and sync to your own server. The VS Code extension uses the same CLI under the hood, and both read and write the same `.ophan/index.db`.

## Install

Requires Node.js 20 or newer. Run it with `npx` (nothing to install):

```bash
npx @ophan/cli <command>
```

Or install it globally, or as a dev dependency:

```bash
npm install -g @ophan/cli      # then: ophan <command>
npm install -D @ophan/cli      # then: npx ophan <command>
```

## Configure

Set your Anthropic API key in the environment, or in a `.env` file in the directory you run the CLI from:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | Required for analysis and `graph --summarize` |
| `OPHAN_MODEL` | Claude model to use (default `claude-sonnet-5-5`) |
| `OPHAN_SERVER_URL` | Your Ophan server, instead of the one saved by `login --server` |
| `OPHAN_SUPABASE_URL`, `OPHAN_SUPABASE_ANON_KEY` | Talk to a server's Supabase directly (CI), skipping its `/api/config` |

All commands take `-p, --path <dir>` (default: the current directory).

## Typical use

```bash
cd my-project
npx @ophan/cli init        # once: create .ophan/, index functions (no network)
npx @ophan/cli watch       # analyze, then re-analyze changed functions on save
```

With a [self-hosted server](self-hosting.md):

```bash
npx @ophan/cli login --server https://ophan.example.com   # once per machine
npx @ophan/cli watch --sync
```

## Commands

### `init`

```bash
npx @ophan/cli init [-p <dir>]
```

Creates `.ophan/` with its SQLite database, adds `.ophan/` to `.gitignore`, and indexes every TypeScript, JavaScript and Python function. Local only: no API calls.

### `analyze`

```bash
npx @ophan/cli analyze [-p <dir>]
```

One-shot analysis, then exit. Extracts every function, hashes it, and sends only functions without a stored result to Claude. If you're signed in to a server, results it already has are pulled first instead of re-analyzed.

```
🔮 Ophan analyzing...

  [1/42] src/main.ts
  ...
✅ Done! 24 analyzed, 18 cached across 42 files
   Database: .ophan/index.db
```

`analyze` exits 0 whether or not it finds issues: it keeps analysis current, it isn't a CI gate.

### `watch`

```bash
npx @ophan/cli watch [-p <dir>] [--sync] [--json]
```

Runs `analyze`, then watches for saves and re-analyzes changed functions about 5 seconds after the last save.

| Flag | Meaning |
|---|---|
| `--sync` | Push results to your server after each batch (debounced). Needs `login`; warns and carries on without one. |
| `--json` | One JSON event per line instead of text (what the extension consumes) |

Details: one watcher per repo (`.ophan/watch.lock`); ignores `node_modules`, `.ophan` and anything your `.gitignore` files ignore; after repeated failures it pauses briefly instead of hammering the API.

JSON events: `scan_progress`, `scan_complete`, `analyzing`, `analyzed`, `pull_progress`, `synced`, `sync_warning`, `sync_error`, `error`.

```json
{"event":"scan_complete","files":2,"analyzed":0,"cached":2,"pulled":0}
{"event":"analyzing","file":"src/users.ts"}
{"event":"analyzed","file":"src/users.ts","analyzed":1,"cached":2,"pulled":0,"duration_ms":1649}
{"event":"synced","pushed":2,"locations":3}
```

### `graph`

```bash
npx @ophan/cli graph [-p <dir>] [--summarize] [options]
```

Builds a graph of how functions relate (calls, imports, co-location, directory distance) and clusters it into communities of related functions. With `--summarize`, Claude writes documentation for each community (L1 subsystems), groups of them (L2 systems), the whole codebase (L3 architecture), and cross-cutting concerns such as PII flowing through several subsystems. Unchanged communities are cached.

| Flag | Default | Meaning |
|---|---|---|
| `-a, --algorithm <name>` | `leiden` | `leiden`, `louvain` or `label-propagation` |
| `-r, --resolution <n>` | `3` | Higher means more, smaller communities |
| `--min-size <n>` | `3` | Smaller clusters are dissolved |
| `--max-size <n>` | `18` | Target maximum community size |
| `--directory-decay <n>` | `0.7` | How strongly directory distance keeps communities local (`0` turns it off) |
| `--summarize` | off | Generate docs with Claude |
| `--raw-source` | off | With `--summarize`: document from function source instead of analysis results (sends source code to Claude) |
| `--compare` | off | Compare several algorithm settings side by side |
| `--json` | off | JSON output |

Run `analyze` first: summaries are built from analysis results.

### `gc`

```bash
npx @ophan/cli gc [-p <dir>] [-d <days>] [--force]
```

Deletes stored analysis for functions that no longer exist anywhere in the repo and haven't been seen for `--days` (default 30). Manual only. Refuses to run off the default branch unless `--force`, because a function deleted on a feature branch may still exist on `main`. If you sync, deletions propagate to your server.

### `login`

```bash
npx @ophan/cli login --server https://ophan.example.com
```

Signs in to your [self-hosted server](self-hosting.md): saves the server in `~/.ophan/config.json`, opens a browser to sign in (or prints the URL), and stores the session in `~/.ophan/credentials.json`. Later commands reuse the saved server; `--server` is only needed the first time or to switch servers (which signs you out of the old one).

### `logout`

Removes `~/.ophan/credentials.json`.

### `sync`

```bash
npx @ophan/cli sync [-p <dir>]
```

Pulls analysis your server has that you don't, then pushes your unsynced results, file locations and (on the docs branch, `main` by default) architecture docs. See [cloud-sync.md](cloud-sync.md).

## CI

Keep analysis current on every push to `main`, for example to feed a self-hosted dashboard:

```yaml
# .github/workflows/ophan.yml
name: Ophan
on:
  push:
    branches: [main]
jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/cache@v4
        with:
          path: .ophan
          key: ophan-${{ github.sha }}
          restore-keys: ophan-
      - run: npx @ophan/cli analyze
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Caching `.ophan/` means each run only pays for functions changed since the last one. `analyze` doesn't fail the build on findings.

## Files

| Path | What |
|---|---|
| `.ophan/index.db` | Per-repo analysis database (gitignored) |
| `.ophan/watch.lock` | Stops two watchers running on one repo |
| `~/.ophan/config.json` | Saved server URL and its public Supabase settings |
| `~/.ophan/credentials.json` | Your session for that server |
