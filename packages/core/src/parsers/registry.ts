// Parser registry -- maps file extensions to language parsers
//
// The registry is the single lookup point used by analyzeRepository() and refreshFileIndex()
// to determine which parser handles a given file. Parsers self-register on import via
// registerParser(), and the glob pattern for file discovery is built dynamically from
// getSupportedExtensions() so adding a new language automatically includes its files.

import * as path from "path";
import type { LanguageParser } from "./types";

/** Maps file extension (e.g. ".ts") to its parser */
const parsersByExtension = new Map<string, LanguageParser>();

/** All registered parsers for iteration */
const allParsers: LanguageParser[] = [];

export function registerParser(parser: LanguageParser): void {
  allParsers.push(parser);
  for (const ext of parser.extensions) {
    parsersByExtension.set(ext.toLowerCase(), parser);
  }
}

export function getParserForFile(filePath: string): LanguageParser | null {
  const ext = path.extname(filePath).toLowerCase();
  return parsersByExtension.get(ext) || null;
}

/** Returns all supported file extensions (e.g. [".ts", ".tsx", ".js", ".jsx", ".py"]) */
export function getSupportedExtensions(): string[] {
  return Array.from(parsersByExtension.keys());
}

/** Returns all registered parsers */
export function getRegisteredParsers(): readonly LanguageParser[] {
  return allParsers;
}
