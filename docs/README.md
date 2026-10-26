# Ophan documentation

## Using Ophan

- [Getting started](getting-started.md): what Ophan does and your first analysis
- [VS Code extension](extension.md): installing (Marketplace, Open VSX, VSIX, from source), settings, troubleshooting
- [CLI](cli.md): every command and flag, CI usage
- [Security analysis](security-analysis.md): flags, findings, data tags, priorities
- [Coding practices](practices.md): your own rules, checked during analysis
- [Sync](cloud-sync.md): sharing analysis across machines and teams

## Running a server

- [Self-hosting](self-hosting.md): Supabase, the webapp container, connecting clients, upgrades

## Contributing

- [Contributing guide](../CONTRIBUTING.md): setup, workflow, standards
- [Development](development.md): local stack, dev loops per package
- [Testing](testing.md): test philosophy and utilities
- [Releasing](releasing.md): versions, native binaries, publishing
- [Distribution](distribution.md): how the extension and CLI are packaged
- [UI guidelines](ui-guidelines.md)

### Architecture

- [Analysis types](architecture/analysis-types.md): documentation, security and practices analyses, schema versions
- [Sync](architecture/sync.md): push/pull model, content addressing
- [Migrations](architecture/migrations.md): local SQLite and Supabase schema changes
- [Extension lifecycle](architecture/extension-lifecycle.md): watch mode, diagnostics, remediation detection
- [Security dashboard](architecture/security-dashboard.md)
- [Webapp auth](architecture/webapp-auth.md): Supabase SSR, runtime config, CLI tokens
- [Auto docs](architecture/auto-docs.md), [community detection](architecture/community-detection-guide.md), [package-aware communities](architecture/package-aware-communities.md), [graph hyperparameters](architecture/graph-hyperparameters.md), [graph performance](architecture/graph-performance.md)
- [Native binary bundling](release-lifecycle/native-binary-bundling.md), [publishing](release-lifecycle/publishing.md)
