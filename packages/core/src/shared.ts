// Shared types and utilities used by both the parser modules and the main analysis engine.
// This file exists to avoid circular dependencies between index.ts and parsers/.

import { createHash } from "crypto";

// ============ TYPES ============

export interface FunctionInfo {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  sourceCode: string;
  contentHash: string;
  language: string;    // e.g. "typescript", "javascript", "python". Set by parser at extraction time.
  entityType: string;  // e.g. "function", "method". Set by parser from AST node kind.

  // Relationship data (optional -- populated by parsers that support graph analysis)
  calls?: string[];    // Names of functions called within this function body
  jsxRefs?: string[];  // JSX component references (<Button />, <Card />) -- weaker signal than calls
  imports?: ImportRef[]; // Imports used by this function's containing module
  exported?: boolean;  // Whether this function is exported (entry point candidate)
}

export interface ImportRef {
  module: string;      // Module specifier (e.g. "./auth", "express", "fs")
  names: string[];     // Imported names (e.g. ["login", "logout"]). Empty = default/namespace import.
}

// ============ UTILITIES ============

export function computeHash(str: string): string {
  return createHash("sha256").update(str).digest("hex");
}
