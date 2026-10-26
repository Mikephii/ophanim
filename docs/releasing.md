# Releasing

For maintainers. Releases are cut by pushing a `v*` tag; `.github/workflows/release.yml` does the rest.

## What a release publishes

| Job | Publishes | When |
|---|---|---|
| `publish-core` | `@ophan/core` to npm | `packages/core` version differs from npm |
| `publish-cli` | `@ophan/cli` to npm | `packages/cli` version differs from npm |
| `build-vscode` + `publish-vscode` | Six platform VSIXs to the VS Code Marketplace and Open VSX | `packages/vscode` version differs from the Marketplace |
| `github-release` | A GitHub Release for the tag, with generated notes and every VSIX attached | Every tag |
| `publish-webapp-image` | `ghcr.io/<owner>/ophan-webapp:<version>`, `:<major>.<minor>` and `:latest` (amd64 + arm64) | Every tag |

Packages whose version didn't change are skipped, so a tag can release just the CLI, or just the extension.

## Cutting a release

1. Bump versions in `packages/core/package.json`, `packages/cli/package.json` and/or `packages/vscode/package.json`. Keep them in step unless there's a reason not to.
2. Add a section to `CHANGELOG.md`.
3. If dependencies changed, run `pnpm notices` and commit `THIRD_PARTY_NOTICES.md`.
4. Merge to `main` with CI green.
5. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
6. Approve the `production` environment when GitHub asks (publishing jobs wait for it).

## One-time setup

| What | Where |
|---|---|
| `production` environment with required reviewers | Repo **Settings → Environments** |
| `VSCE_PAT` secret (Azure DevOps PAT, scope **Marketplace → Manage**, for publisher `ophan`) | Environment `production` |
| `OVSX_PAT` secret (open-vsx.org access token; the `ophan` namespace must exist: `npx ovsx create-namespace ophan`) | Environment `production` |
| npm trusted publishing for `@ophan/core` and `@ophan/cli`: repository `Mikephii/ophanim`, workflow `release.yml`, environment `production` | npmjs.com, each package's **Settings → Trusted publishing** |
| GHCR | Nothing: uses `GITHUB_TOKEN`. Make the `ophan-webapp` package public after the first push (**Packages → Package settings**). |

## Native binaries

The extension loads `better-sqlite3`, a native module whose ABI must match the editor's Electron. `build-vscode` compiles it once per Electron ABI on each platform runner and packs all of them into that platform's VSIX; `packages/vscode/src/native-loader.ts` picks the right one at runtime. When a new VS Code (or Cursor) ships a new Electron, add its ABI to the list in `release.yml` and `packages/vscode/scripts/build-native.sh`. Details: [native-binary-bundling.md](release-lifecycle/native-binary-bundling.md).

## npm specifics

`pnpm pack` then `npm publish` (for OIDC provenance), and why: [publishing.md](release-lifecycle/publishing.md).

## Server schema changes

Releases don't touch anyone's database. Self-hosters apply new migrations from `supabase/migrations/` themselves (`supabase db push`, see [self-hosting.md](self-hosting.md#upgrading)), so call out new migrations in the changelog.
