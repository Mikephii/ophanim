// Parser barrel export -- auto-registers all language parsers
//
// Importing this module registers all available parsers. To add a new language:
// 1. Create a parser file in this directory implementing LanguageParser
// 2. Import and register it below
// That's it -- analyzeRepository() and refreshFileIndex() pick it up automatically.

import { registerParser } from "./registry";
import { TypeScriptParser } from "./typescript";
import { PythonParser } from "./python";

registerParser(new TypeScriptParser());
registerParser(new PythonParser());

export type { LanguageParser } from "./types";
export { getParserForFile, getSupportedExtensions, getRegisteredParsers } from "./registry";
