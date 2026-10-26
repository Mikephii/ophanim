import type { ModuleResolver } from "../graph";

/**
 * Strategy interface for language-specific module resolution.
 * Each implementation handles import specifier → file path resolution
 * for one language ecosystem (JS/TS, Python, Go, etc.).
 */
export interface LanguageModuleResolver {
  /** Language identifier (e.g., "typescript", "python") */
  readonly language: string;
  /** File extensions this resolver handles (e.g., [".ts", ".tsx", ".js", ".jsx"]) */
  readonly extensions: readonly string[];
  /**
   * Resolve an import module specifier to an absolute file path.
   * Returns undefined if the specifier can't be resolved.
   */
  resolveModuleToFile(
    importModule: string,
    importerFilePath: string,
    fileToHashes: Map<string, Set<string>>,
    workspaceResolver?: ModuleResolver,
  ): string | undefined;
}
