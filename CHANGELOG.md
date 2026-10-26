# Changelog

All notable changes to Ophan are listed here. Versions follow [semantic versioning](https://semver.org);
before 1.0, minor versions may include breaking changes.

## 0.1.0 (first public release)

Ophan is now open source under the MIT License, and self-hosted only: there is no hosted service and
no server is built into any package.

### Added
- **Self-hosting.** `deploy/docker-compose.yml`, a runtime-configured webapp image, and
  [docs/self-hosting.md](docs/self-hosting.md). The webapp serves `GET /api/config` so clients can
  configure themselves from one URL.
- `ophan login --server <url>`, `OPHAN_SERVER_URL`, and `OPHAN_SUPABASE_URL` / `OPHAN_SUPABASE_ANON_KEY`
  for choosing a server. The chosen server is saved in `~/.ophan/config.json`.
- Extension setting `ophan.serverUrl`. Without it the extension is purely local and never asks you
  to sign in.
- `OPHAN_MODEL` to choose the Claude model (default `claude-sonnet-5-5`).
- Function graph view and community detection improvements (`ophan graph`).
- Documentation in `docs/`, CONTRIBUTING, SECURITY, third-party notices.

### Changed
- Analysis and summaries use `claude-sonnet-5-5`. The previous model was retired and analysis no
  longer worked.
- The CLI requires Node.js 20 or newer.
- `ophan login` replaces `--webapp-url` / `OPHAN_WEBAPP_URL` with `--server` / `OPHAN_SERVER_URL`.

### Fixed
- Real API errors are reported instead of `#<Object>`; retries only happen for rate limits,
  overload and server errors.
- Replies that start with a thinking block are parsed correctly; refusals and truncated replies
  produce clear errors.
- `ophan login` opens the browser again (it silently failed in published builds).
- Webapp sign-in works when the server reaches Supabase on a different address than browsers do.
- A React hydration error on every webapp page in dark mode.
- A webapp started without its Supabase settings answers with a 503 naming the missing variables
  (`/api/health` stays up) instead of a bare 500 on every route.
- `pnpm vs:sideload` builds the native SQLite module, so extensions built from source load.

### Removed
- The hosted-service defaults (`app.ophan.dev`), the docs site package, and the AWS deployment stack.
