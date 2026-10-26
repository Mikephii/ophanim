// TypeScript/JavaScript parser -- uses the TypeScript compiler API
//
// Handles .ts, .tsx, .js, .jsx files. The TypeScript compiler can parse JavaScript too,
// so one parser covers both languages (with correct language labels).
//
// The TS compiler API gives us deep understanding of function types: declarations, methods,
// arrow functions, and function expressions. This is more reliable than regex or tree-sitter
// for TypeScript specifically, and it's already a dependency.

import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import type { FunctionInfo, ImportRef } from "../shared";
import { computeHash } from "../shared";
import type { LanguageParser } from "./types";

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  return "javascript";
}

function detectEntityType(node: ts.Node): string {
  if (ts.isMethodDeclaration(node)) return "method";
  return "function";
}

export class TypeScriptParser implements LanguageParser {
  readonly language = "typescript"; // label for the primary language
  readonly extensions = [".ts", ".tsx", ".js", ".jsx"];

  extractFunctions(filePath: string): FunctionInfo[] {
    const content = fs.readFileSync(filePath, "utf-8");
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    const language = detectLanguage(filePath);
    const functions: FunctionInfo[] = [];

    // Collect file-level imports (shared across all functions in this file)
    const fileImports = extractImports(sourceFile);

    function visit(node: ts.Node) {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node)
      ) {
        const name = getFunctionName(node);
        if (!name) return;

        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
        const sourceCode = node.getText(sourceFile);

        const { calls, jsxRefs } = extractCallExpressions(node, sourceFile);
        functions.push({
          name,
          filePath,
          startLine: start.line + 1,
          endLine: end.line + 1,
          sourceCode,
          contentHash: computeHash(sourceCode),
          language,
          entityType: detectEntityType(node),
          calls,
          jsxRefs: jsxRefs.length > 0 ? jsxRefs : undefined,
          imports: fileImports,
          exported: isExported(node),
        });
      }

      ts.forEachChild(node, visit);
    }

    function getFunctionName(node: ts.Node): string | null {
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
        return node.name?.getText(sourceFile) || null;
      }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const parent = node.parent;
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
          return parent.name.getText(sourceFile);
        }
      }
      return null;
    }

    visit(sourceFile);
    return functions;
  }
}

// ============ RELATIONSHIP EXTRACTION ============

/**
 * Extract call expression names and JSX component references from inside a function body.
 * Returns separate arrays: `calls` for direct function calls (strong signal) and
 * `jsxRefs` for JSX component references (weaker signal -- UI composition, not domain logic).
 */
function extractCallExpressions(
  node: ts.Node,
  sourceFile: ts.SourceFile
): { calls: string[]; jsxRefs: string[] } {
  const calls = new Set<string>();
  const jsxRefs = new Set<string>();

  function walkCalls(n: ts.Node) {
    if (ts.isCallExpression(n)) {
      const name = getCallName(n.expression, sourceFile);
      if (name) calls.add(name);
    }
    // JSX elements: <Foo /> treated as a component reference (separate from calls)
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tagName = n.tagName;
      if (ts.isIdentifier(tagName)) {
        const name = tagName.getText(sourceFile);
        // Only PascalCase (React components), not HTML elements (div, span)
        if (name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()) {
          jsxRefs.add(name);
        }
      }
    }
    ts.forEachChild(n, walkCalls);
  }

  // Walk the function body (not the signature)
  const body = getFunctionBody(node);
  if (body) walkCalls(body);

  return { calls: [...calls], jsxRefs: [...jsxRefs] };
}

function getCallName(expr: ts.Expression, sourceFile: ts.SourceFile): string | null {
  // Direct call: foo()
  if (ts.isIdentifier(expr)) {
    return expr.getText(sourceFile);
  }
  // Method calls (obj.method()) are excluded -- they typically reference
  // library APIs (db.prepare, res.json, arr.map) and produce false matches.
  // Intra-project method calls are captured by co-location and import edges instead.
  return null;
}

function getFunctionBody(node: ts.Node): ts.Node | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node)
  ) {
    return node.body || null;
  }
  if (ts.isArrowFunction(node)) {
    return node.body;
  }
  return null;
}

/**
 * Extract import declarations from the top level of a source file.
 */
function extractImports(sourceFile: ts.SourceFile): ImportRef[] {
  const imports: ImportRef[] = [];

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;

    const moduleSpec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpec)) continue;

    const module = moduleSpec.text;
    const names: string[] = [];

    const clause = stmt.importClause;
    if (clause) {
      // Skip entire type-only imports: import type { X } from "..."
      if (clause.isTypeOnly) continue;
      // Default import: import Foo from "..."
      if (clause.name) {
        names.push(clause.name.getText(sourceFile));
      }
      // Named imports: import { a, b } from "..."
      if (clause.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            // Skip individual type-only specifiers: import { type X, Y } from "..."
            if (el.isTypeOnly) continue;
            names.push(el.name.getText(sourceFile));
          }
        }
        // Namespace import: import * as ns from "..."
        if (ts.isNamespaceImport(clause.namedBindings)) {
          names.push(clause.namedBindings.name.getText(sourceFile));
        }
      }
    }

    imports.push({ module, names });
  }

  return imports;
}

/**
 * Check if a function/variable declaration has the `export` modifier.
 */
function isExported(node: ts.Node): boolean {
  // Function declarations: check modifiers directly
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return hasExportModifier(node);
  }
  // Arrow functions / function expressions: check parent variable statement
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent; // VariableDeclaration
    if (parent && ts.isVariableDeclaration(parent)) {
      const declList = parent.parent; // VariableDeclarationList
      if (declList && ts.isVariableDeclarationList(declList)) {
        const varStmt = declList.parent; // VariableStatement
        if (varStmt && ts.isVariableStatement(varStmt)) {
          return hasExportModifier(varStmt);
        }
      }
    }
  }
  return false;
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!modifiers) return false;
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}
