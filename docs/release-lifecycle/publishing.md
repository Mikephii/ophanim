# Publishing npm Packages

## CLI Build (esbuild)

The CLI is built with esbuild, which bundles all dependencies (including `@ophan/core`) into a single `dist/index.js` file. Only `better-sqlite3` is kept external (native module).

Nothing environment-specific is baked in: the CLI finds its self-hosted server at runtime (`packages/cli/src/server.ts`). The build only defines the CLI version (`process.env.OPHAN_CLI_VERSION`) and shims `import.meta.url`, which ESM dependencies such as `open` read and esbuild otherwise empties in CJS output.

## The `workspace:*` Protocol (core only)

`@ophan/core` uses pnpm workspaces. When publishing core, `workspace:*` references **must** be replaced with real version numbers -- `npm publish` passes `workspace:*` through verbatim.

**Note:** The CLI bundles core via esbuild, so `@ophan/core` is a devDependency of the CLI (not a runtime dependency). The `workspace:*` protocol only matters for publishing `@ophan/core` itself, not the CLI.

## CI Publishing (Two-Step: pnpm pack + npm publish)

The CI workflow uses npm's OIDC trusted publishing for provenance (the `id-token: write` permission). This auth mechanism is not supported by `pnpm publish`, so we can't use `pnpm publish` directly in CI.

The solution is a two-step process:

```yaml
# Step 1: pnpm pack creates a tarball with workspace:* replaced
- run: pnpm pack
  working-directory: packages/core

# Step 2: npm publish uploads the tarball with OIDC auth
- run: npm publish packages/core/ophan-core-*.tgz --access public
```

This gives us both: workspace protocol resolution (pnpm) and OIDC trusted publishing (npm).

See `.github/workflows/release.yml` for the full workflow.

## Local Publishing

For manual/local publishes, `pnpm publish` works directly (OIDC is only needed in CI):

```bash
# Single package
pnpm pub:core    # publishes @ophan/core
pnpm pub:cli     # publishes @ophan/cli

# Both (core first, then cli)
pnpm pub:all
```

These scripts are defined in the root `package.json`.

**Always publish core before cli** -- the cli depends on core, and `pnpm publish` resolves `workspace:*` to the version in core's `package.json` at publish time.

## Version Bumping

All three packages (core, cli, vscode) should be kept at the same version for simplicity:

```bash
# Bump all to 0.0.6
cd packages/core && pnpm version 0.0.6 --no-git-tag-version
cd packages/cli && pnpm version 0.0.6 --no-git-tag-version
cd packages/vscode && pnpm version 0.0.6 --no-git-tag-version
```

## Verification

After publishing, always verify the workspace references were replaced:

```bash
npm view @ophan/cli@0.0.5 dependencies --json
# Should show: "@ophan/core": "0.0.5" (NOT workspace:*)
```

To verify locally before publishing:

```bash
cd packages/cli && pnpm pack
tar -xzf ophan-cli-*.tgz
grep core package/package.json
# Should show: "@ophan/core": "0.0.5"
rm -rf package ophan-cli-*.tgz
```

## Common Pitfalls

| Mistake | Result | Fix |
|---------|--------|-----|
| `npm publish` without `pnpm pack` | `workspace:*` in published package | Use two-step: `pnpm pack` then `npm publish <tarball>` |
| Publishing cli before core | cli references old core version | Always publish core first (`pnpm pub:all` handles this) |
| `pnpm publish` in CI | OIDC auth fails | Use `pnpm pack` + `npm publish` in CI |
