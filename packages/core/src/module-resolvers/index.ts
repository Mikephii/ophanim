export type { LanguageModuleResolver } from "./types";
export { JavaScriptModuleResolver } from "./javascript";

import type { LanguageModuleResolver } from "./types";
import { JavaScriptModuleResolver } from "./javascript";
import * as path from "path";

const registry = new Map<string, LanguageModuleResolver>();

export function registerModuleResolver(resolver: LanguageModuleResolver): void {
  registry.set(resolver.language, resolver);
}

export function getModuleResolver(
  language: string,
): LanguageModuleResolver | undefined {
  return registry.get(language);
}

/**
 * Find the module resolver that handles a given file path,
 * matched by file extension against resolver.extensions.
 */
export function getModuleResolverForFile(
  filePath: string,
): LanguageModuleResolver | undefined {
  const ext = path.extname(filePath).toLowerCase();
  for (const resolver of registry.values()) {
    if (resolver.extensions.includes(ext)) return resolver;
  }
  return undefined;
}

// Register built-in resolvers
const jsResolver = new JavaScriptModuleResolver();
registerModuleResolver(jsResolver);
// Also register under "javascript" alias
registry.set("javascript", jsResolver);
