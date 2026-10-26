# @ophan/cli

AI security review and documentation for your codebase, from the command line. Ophan reads every function with Claude, flags vulnerabilities on the exact line, tags where user input, PII and credentials flow, and documents every function.

Part of [Ophan](https://github.com/Mikephii/ophanim). Works on its own or alongside the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=ophan.ophan); both share the same results.

## Quick start

Requires Node.js 20+ and an [Anthropic API key](https://console.anthropic.com/) in `ANTHROPIC_API_KEY` (or a `.env` file).

```bash
npx @ophan/cli init      # index your functions (local, no network)
npx @ophan/cli watch     # analyze, then re-analyze changed functions on save
```

Results are stored in `.ophan/index.db` in your repo (gitignored for you). Each function is keyed by the SHA256 of its source, so unchanged functions are never sent to Claude twice.

## What you get

For every TypeScript, JavaScript and Python function:

- **Security findings**: SQL injection, XSS, hardcoded secrets, command injection, path traversal, unsafe eval and deserialization, with the exact line, severity, explanation and fix
- **Data flow tags**: user input, PII, credentials, database, external APIs, file system
- **Documentation**: description, parameters and return value

## Commands

```bash
npx @ophan/cli init                     # create .ophan/ and index functions
npx @ophan/cli analyze                  # analyze once and exit (CI)
npx @ophan/cli watch [--sync] [--json]  # analyze on save
npx @ophan/cli graph --summarize        # cluster functions, write architecture docs
npx @ophan/cli gc                       # drop analysis for deleted functions
npx @ophan/cli login --server <url>     # sign in to your self-hosted Ophan server
npx @ophan/cli sync                     # pull + push analysis with that server
```

All commands take `--path <dir>`. Full reference: [docs/cli.md](https://github.com/Mikephii/ophanim/blob/main/docs/cli.md).

## Privacy

Function source is sent only to the Anthropic API, with your key, and only for functions without a stored result. Sync is optional and only to [a server you run](https://github.com/Mikephii/ophanim/blob/main/docs/self-hosting.md); it sends analysis results, never source code.

## Links

- [Source and documentation](https://github.com/Mikephii/ophanim)
- [VS Code extension](https://marketplace.visualstudio.com/items?itemName=ophan.ophan)
- [Issues](https://github.com/Mikephii/ophanim/issues)

## License

MIT. See [LICENSE](https://github.com/Mikephii/ophanim/blob/main/LICENSE).
