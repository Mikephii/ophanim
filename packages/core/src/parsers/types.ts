// Parser interface -- the abstraction that enables multi-language support
//
// Each language implements LanguageParser to extract function-like entities from source files.
// The interface is deliberately minimal: given a file path, return an array of FunctionInfo.
//
// Why not tree-sitter or a custom LSP?
//   - Tree-sitter adds native C dependencies and grammar management complexity.
//   - A custom LSP is unnecessary -- the CLI + SQLite DB is the cross-IDE abstraction.
//   - Instead, each parser uses the language's own tooling: TypeScript compiler API for TS/JS,
//     Python's ast module for Python, go/parser for Go, etc. Zero extra dependencies per language.
//
// To add a new language:
//   1. Create a new file in this directory (e.g., go.ts)
//   2. Implement LanguageParser with the correct extensions and extractFunctions()
//   3. Register it in parsers/index.ts
//   That's it -- the analysis pipeline, hashing, DB storage, and sync all work unchanged.

import type { FunctionInfo } from "../shared";

export interface LanguageParser {
  /** Language identifier stored in DB, e.g. "typescript", "python" */
  readonly language: string;

  /** File extensions this parser handles, including the dot, e.g. [".ts", ".tsx"] */
  readonly extensions: string[];

  /** Extract function-like entities from a source file */
  extractFunctions(filePath: string): FunctionInfo[];
}
