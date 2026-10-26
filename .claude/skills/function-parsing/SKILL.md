---
name: function-parsing
description: Language-specific function extraction from source code. Use when working on parsers, AST traversal, call extraction, import tracking, the parser registry, or adding new language support.
---

# Function Parsing System

## Architecture

Pluggable parser registry. Each language uses its native tooling (TypeScript compiler API, Python `ast` module). Parsers extract `FunctionInfo` objects with relationship data for graph building.

## Parser Interface

```typescript
// packages/core/src/parsers/types.ts
interface LanguageParser {
  readonly language: string;        // "typescript", "python"
  readonly extensions: string[];    // [".ts", ".tsx", ".js", ".jsx"]
  extractFunctions(filePath: string): FunctionInfo[];
}
```

## FunctionInfo Contract

```typescript
// packages/core/src/shared.ts
interface FunctionInfo {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  sourceCode: string;
  contentHash: string;       // SHA256(sourceCode)
  language: string;          // "typescript" | "javascript" | "python"
  entityType: string;        // "function" | "method"
  calls?: string[];          // Direct function calls within body
  jsxRefs?: string[];        // JSX component references (<Button />, <Card />)
  imports?: ImportRef[];     // File-level imports
  exported?: boolean;        // Whether function is exported
}

interface ImportRef {
  module: string;            // "./auth", "express", "fs"
  names: string[];           // ["login", "logout"]
}
```

## TypeScript/JavaScript Parser

**File:** `packages/core/src/parsers/typescript.ts`
**Extensions:** `.ts`, `.tsx`, `.js`, `.jsx`

### Extracted Node Types
- `FunctionDeclaration` → entityType "function"
- `MethodDeclaration` → entityType "method"
- `ArrowFunction` → entityType "function" (name from parent `VariableDeclaration`)
- `FunctionExpression` → entityType "function" (name from parent `VariableDeclaration`)

### Naming Rules
- Function/method declarations: name directly from AST node
- Arrow functions: name from parent variable declaration (`const handler = () => {}` → "handler")
- Unnamed arrows/callbacks (no variable parent): **skipped entirely**
- Unnamed default exports: **skipped**

### Language Detection
- `.ts`/`.tsx` → "typescript"
- `.js`/`.jsx` → "javascript"

### Call Extraction Strategy
- **`calls[]`:** Direct function calls (`foo()`, `validate()`, `initDb()`) → creates `call` edges (weight 1.0)
- **`jsxRefs[]`:** JSX component references (`<Button />`, `<Card />`) → creates `jsx_ref` edges (weight 0.3). PascalCase only, HTML elements excluded. Separated from calls because UI composition is a weaker domain signal than direct function calls.
- **Excludes:** Method calls (`db.prepare()`, `req.json()`, `arr.map()`)
- **Rationale:** Method calls are mostly library APIs (noise). JSX refs are separated because `<AlertDialog>` shouldn't pull a component into the AlertDialog community over its same-file siblings.
- Walks function body only (not signature)

### Import Extraction
- Collects all file-level `import` statements (shared across functions in file)
- Supports: default imports, named imports `{ a, b }`, namespace imports `* as ns`
- Stores module specifier + imported names
- **Type import filtering:** Skips `import type { X } from "..."` (entire declaration) and `import { type X, Y }` (individual specifier). Only runtime imports appear in `ImportRef.names`, preventing false edge matches on type-only symbols.

### Export Detection
- Function declarations: checks for `export` keyword modifier
- Arrow/expression functions: walks up to parent `VariableStatement`, checks for `export` modifier
- Uses `ts.getModifiers()` API (not deprecated `node.modifiers`)

## Python Parser

**File:** `packages/core/src/parsers/python.ts`
**Extension:** `.py`

### Implementation
- Runs Python's `ast` module via subprocess (`execFileSync("python3", ...)`)
- 10-second timeout per file
- Graceful fallback: if `python3` not found, returns `[]` with warning

### Extracted Node Types
- `FunctionDef` → "function" (module-level) or "method" (inside `ClassDef`)
- `AsyncFunctionDef` → same rules
- Parent detection via `_parent` annotation on AST walk

### Key Differences from TypeScript
- **Exported:** Module-level functions (not nested in class) are considered "exported"
- **Call extraction:** Same as TS -- direct `Name` calls only, excludes `Attribute` calls
- **Imports:** Both `import X` and `from X import Y` patterns

## Parser Registry

**File:** `packages/core/src/parsers/registry.ts`

```typescript
registerParser(parser)          // Adds parser, maps extensions
getParserForFile(filePath)      // Returns parser by file extension
getSupportedExtensions()        // All registered extensions
getRegisteredParsers()          // All parsers for iteration
```

Auto-registered in `parsers/index.ts`:
```typescript
registerParser(new TypeScriptParser());
registerParser(new PythonParser());
```

## Adding a New Language

1. Create `packages/core/src/parsers/{language}.ts` implementing `LanguageParser`
2. Add test file `{language}.test.ts` and fixtures in `__fixtures__/`
3. Register in `parsers/index.ts`
4. Hash computation uses same `computeHash(sourceCode)` -- language-agnostic
5. Set `language` and `entityType` fields at parse time

## Test Fixtures

Located in `packages/core/src/parsers/__fixtures__/`:
- `arrow-functions.ts` -- exported/unexported arrows, unnamed default, callbacks
- `class-methods.ts` -- methods + standalone function
- `call-extraction.ts` -- direct calls vs method calls
- `type-imports.ts` -- `import type`, `{ type X }`, runtime imports, namespace imports
- `jsx-components.tsx` -- JSX component references as calls
- `no-functions.ts` -- file with no extractable functions
- `simple.py`, `class-methods.py` -- Python equivalents

## Key Files

- `packages/core/src/parsers/typescript.ts` -- TS/JS parser
- `packages/core/src/parsers/python.ts` -- Python parser
- `packages/core/src/parsers/registry.ts` -- Parser registry
- `packages/core/src/parsers/types.ts` -- LanguageParser interface
- `packages/core/src/shared.ts` -- FunctionInfo, computeHash()
- `packages/core/src/parsers/typescript.test.ts` -- Parser tests
