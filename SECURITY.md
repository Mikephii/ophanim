# Security

## Reporting a vulnerability

Please report vulnerabilities in Ophan privately through GitHub's
[private vulnerability reporting](https://github.com/Mikephii/ophanim/security/advisories/new),
not in a public issue.

Include what you found, how to reproduce it, and which version and component it affects. Ophan is
maintained in spare time, so this is best effort: I aim to acknowledge reports within a week, keep
you updated, and credit you in the release notes unless you'd rather I didn't.

## Scope

In scope: the code in this repository.

- The CLI and core: anything that runs code from an analyzed repository, writes outside `.ophan/`
  and `~/.ophan/`, sends source code anywhere other than the configured Anthropic API, or leaks the
  API key or session tokens
- The VS Code extension and its webview (e.g. script injection through analysis content)
- The webapp: authentication, the CLI sign-in handoff, row-level security bypasses, anything that
  exposes one user's data to another or the service role key to clients
- The database schema and policies in `supabase/migrations/`
- The deploy files in `deploy/`

Out of scope:

- **The quality of findings.** A vulnerability Ophan missed, or a false positive, is a bug: please
  [open an issue](https://github.com/Mikephii/ophanim/issues).
- Issues in Supabase, the Anthropic API, VS Code or other third-party software; report those to
  their projects.
- Self-hosted servers that skip the hardening in [docs/self-hosting.md](docs/self-hosting.md)
  (for example, no TLS).

## Supported versions

Security fixes land in the latest release.
