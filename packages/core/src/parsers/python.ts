// Python parser -- uses Python's own ast module via python3 subprocess
//
// Zero npm dependencies. Shells out to `python3 -c "..."` with an inline script that uses
// Python's built-in ast module to extract functions, async functions, and class methods.
// The script outputs JSON to stdout which we parse in Node.js.
//
// If python3 is not installed, the parser logs a warning and returns empty results.
// This means Python files are simply skipped during analysis -- TypeScript analysis
// continues working regardless.
//
// Why not a JS-based Python parser?
//   - Python's ast module is the canonical parser, maintained by CPython itself
//   - It handles all Python syntax perfectly (decorators, async, walrus operator, etc.)
//   - Zero maintenance burden -- ast evolves with Python
//   - The subprocess call adds ~50ms per file, acceptable for batch analysis

import { execFileSync } from "child_process";
import * as fs from "fs";
import type { FunctionInfo } from "../shared";
import { computeHash } from "../shared";
import type { LanguageParser } from "./types";

// Inline Python script that extracts function info using the ast module.
// Outputs JSON array to stdout. Uses parent tracking to detect methods vs functions.
const PYTHON_EXTRACT_SCRIPT = `
import ast, json, sys

source = sys.stdin.read()
tree = ast.parse(source)

# Annotate parent references so we can detect methods (FunctionDef inside ClassDef)
for node in ast.walk(tree):
    for child in ast.iter_child_nodes(node):
        child._parent = node

# Extract file-level imports
file_imports = []
for node in ast.iter_child_nodes(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            file_imports.append({"module": alias.name, "names": [alias.asname or alias.name]})
    elif isinstance(node, ast.ImportFrom):
        module = node.module or ""
        names = [alias.name for alias in node.names]
        file_imports.append({"module": module, "names": names})

# Extract call names from a function body
# Only direct function calls (ast.Name), not method calls (ast.Attribute)
# Method calls like obj.method() produce false matches against library APIs
def get_calls(func_node):
    calls = set()
    for node in ast.walk(func_node):
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name):
                calls.add(node.func.id)
    return sorted(calls)

functions = []
lines = source.split('\\n')

for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        end_line = getattr(node, 'end_lineno', None) or node.lineno
        source_code = '\\n'.join(lines[node.lineno - 1 : end_line])

        parent = getattr(node, '_parent', None)
        entity_type = "method" if isinstance(parent, ast.ClassDef) else "function"

        # Module-level functions (not nested in class or other function) are "exported"
        exported = isinstance(parent, ast.Module)

        functions.append({
            "name": node.name,
            "startLine": node.lineno,
            "endLine": end_line,
            "sourceCode": source_code,
            "entityType": entity_type,
            "calls": get_calls(node),
            "exported": exported
        })

json.dump({"functions": functions, "imports": file_imports}, sys.stdout)
`;

let pythonAvailable: boolean | null = null;

function isPythonAvailable(): boolean {
  if (pythonAvailable !== null) return pythonAvailable;
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    pythonAvailable = true;
  } catch {
    pythonAvailable = false;
  }
  return pythonAvailable;
}

interface PythonFunctionInfo {
  name: string;
  startLine: number;
  endLine: number;
  sourceCode: string;
  entityType: string;
  calls: string[];
  exported: boolean;
}

interface PythonImportInfo {
  module: string;
  names: string[];
}

interface PythonExtractResult {
  functions: PythonFunctionInfo[];
  imports: PythonImportInfo[];
}

export class PythonParser implements LanguageParser {
  readonly language = "python";
  readonly extensions = [".py"];

  extractFunctions(filePath: string): FunctionInfo[] {
    if (!isPythonAvailable()) {
      console.warn("python3 not found — skipping Python files. Install Python 3 to enable Python analysis.");
      return [];
    }

    try {
      const source = fs.readFileSync(filePath, "utf-8");
      const output = execFileSync("python3", ["-c", PYTHON_EXTRACT_SCRIPT], {
        input: source,
        encoding: "utf-8",
        timeout: 10000, // 10s timeout per file
      });

      const result: PythonExtractResult = JSON.parse(output);
      const fileImports = result.imports.map((imp) => ({
        module: imp.module,
        names: imp.names,
      }));

      return result.functions.map((fn) => ({
        name: fn.name,
        filePath,
        startLine: fn.startLine,
        endLine: fn.endLine,
        sourceCode: fn.sourceCode,
        contentHash: computeHash(fn.sourceCode),
        language: "python",
        entityType: fn.entityType,
        calls: fn.calls,
        imports: fileImports,
        exported: fn.exported,
      }));
    } catch (err) {
      console.error(`Failed to parse Python file ${filePath}:`, (err as Error).message);
      return [];
    }
  }
}
