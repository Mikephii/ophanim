# @ophan/core

The analysis engine behind [Ophan](https://github.com/Mikephii/ophanim): AI security analysis and documentation for codebases.

This package provides the core analysis pipeline: source code parsing, function extraction, Claude-powered security analysis, and local SQLite storage. Used by [`@ophan/cli`](https://www.npmjs.com/package/@ophan/cli) and the [Ophan VS Code extension](https://marketplace.visualstudio.com/items?itemName=ophan.ophan).

## What It Does

- **Parses source code** using language-native ASTs (TypeScript compiler API, Python's `ast` module)
- **Extracts functions** and computes SHA256 content hashes for change detection
- **Analyzes with Claude** to detect security vulnerabilities and generate documentation
- **Stores results** in a local SQLite database, keyed by content hash

### Security Detection

Identifies vulnerabilities including SQL injection, XSS, hardcoded secrets, path traversal, insecure deserialization, and unsanitized user input.

### Data Flow Classification

Tags functions by the data they handle: user input, PII, credentials, database operations, external APIs, file system access, and more.

### Auto-Documentation

Generates plain-English descriptions, parameter documentation, and return type documentation for every function.

## Supported Languages

| Language | Parser | Extensions |
|----------|--------|------------|
| TypeScript | TypeScript compiler API | `.ts`, `.tsx` |
| JavaScript | TypeScript compiler API | `.js`, `.jsx` |
| Python | Python `ast` module | `.py` |

## Usage

Most users should use [`@ophan/cli`](https://www.npmjs.com/package/@ophan/cli) or the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=ophan.ophan) instead of importing this package directly.

`@ophan/core` is published for tools that need to build on the Ophan analysis pipeline programmatically.

```typescript
import { analyzeRepository } from '@ophan/core';

// Reads ANTHROPIC_API_KEY (and optionally OPHAN_MODEL) from the environment.
// Results are written to /path/to/repo/.ophan/index.db.
const result = await analyzeRepository('/path/to/repo', (current, total, file) => {
  console.log(`[${current}/${total}] ${file}`);
});
console.log(`${result.analyzed} analyzed, ${result.skipped} cached`);
```

The API is not yet stable and may change between minor versions before 1.0.

### Schemas

Zod schemas and TypeScript types for Ophan's analysis data are available as a lightweight subpath import -- no native dependencies required:

```typescript
import {
  ClaudeAnalysisResponse,
  SECURITY_FLAG_LABELS,
  DATA_TAG_LABELS,
} from '@ophan/core/schemas';
```

## Resources

- [Source and documentation](https://github.com/Mikephii/ophanim)
- [`@ophan/cli`](https://www.npmjs.com/package/@ophan/cli)
- [VS Code extension](https://marketplace.visualstudio.com/items?itemName=ophan.ophan)

## License

MIT. See [LICENSE](https://github.com/Mikephii/ophanim/blob/main/LICENSE).
