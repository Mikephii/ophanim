# Sync

Sync shares analysis through a server you run yourself (see [self-hosting.md](self-hosting.md)). It is optional: without a server, Ophan is entirely local.

## What it gets you

- **Across machines**: clone a repo on a new laptop and pull its analysis instead of paying to re-run it.
- **Across a team**: everyone on the same server pulls results for functions anyone has already analyzed. Analysis is keyed by the SHA256 of each function's source, so identical code is only ever analyzed once.
- **The web dashboard**: findings, function docs and architecture docs for every synced repo.
- **Coding practices**: per-repo rules managed in the dashboard (see [practices.md](practices.md)).

## Sign in

```bash
npx @ophan/cli login --server https://ophan.example.com
```

In VS Code: set `ophan.serverUrl`, then run **Ophan: Sign In**.

## How sync works

- **Pull, automatically**: before calling Claude, `analyze`, `watch` and the extension ask your server for any function hashes it already has, and download those results instead. If you're offline or signed out, analysis just runs normally.
- **Push**: `ophan sync` pulls, then pushes your unsynced results. `watch --sync`, and the extension with `ophan.autoSync` on, push after each analysis batch.
- **Insert-only**: results never change once written (same hash, same analysis), so there's nothing to merge and no conflicts.

## What gets sent

Analysis results, never source code: per function, its hash, the analysis (description, parameters, findings, data tags), its repo-relative file path, name and start line. Plus the repo's folder name and git remote URL, and architecture docs if you've run `ophan graph --summarize`.

## Architecture docs and branches

Architecture docs (communities and their summaries) only sync from one branch, `main` by default, so a feature branch can't overwrite them. Change it in the repo's settings in the dashboard. Function analysis syncs from every branch. Each architecture sync records the commit it was built from, shown on the dashboard's architecture page. Folders that aren't git repos always sync architecture docs.

## Account

- Session: `~/.ophan/credentials.json`; server: `~/.ophan/config.json`
- Sign out: `npx @ophan/cli logout`
- Row-level security on the server scopes all data to your account.
