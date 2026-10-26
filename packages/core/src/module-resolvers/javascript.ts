import * as path from "path";
import type { LanguageModuleResolver } from "./types";
import type { ModuleResolver } from "../graph";

/**
 * Module resolution for JavaScript/TypeScript ecosystems.
 * Handles relative imports, workspace packages (via package.json exports),
 * and path aliases (via tsconfig.json paths).
 */
export class JavaScriptModuleResolver implements LanguageModuleResolver {
  readonly language = "typescript";
  readonly extensions = [".ts", ".tsx", ".js", ".jsx"] as const;

  /**
   * Try resolving a base path to an actual file, probing JS/TS extensions
   * and index file patterns.
   */
  private tryResolveWithExtensions(
    resolvedBase: string,
    fileToHashes: Map<string, Set<string>>,
  ): string | undefined {
    for (const candidate of [
      resolvedBase,
      resolvedBase + ".ts",
      resolvedBase + ".tsx",
      resolvedBase + ".js",
      resolvedBase + ".jsx",
      resolvedBase + ".py",
    ]) {
      if (fileToHashes.has(candidate)) return candidate;
    }
    for (const idx of ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"]) {
      if (fileToHashes.has(resolvedBase + idx)) return resolvedBase + idx;
    }
    return undefined;
  }

  resolveModuleToFile(
    importModule: string,
    importerFilePath: string,
    fileToHashes: Map<string, Set<string>>,
    resolver?: ModuleResolver,
  ): string | undefined {
    // Case 1: Relative imports
    if (importModule.startsWith("./") || importModule.startsWith("../")) {
      const resolvedBase = path.resolve(
        path.dirname(importerFilePath),
        importModule,
      );
      return this.tryResolveWithExtensions(resolvedBase, fileToHashes);
    }

    if (!resolver) return undefined;

    // Case 2: Workspace package imports (e.g. "@ophan/core/schemas")
    for (const [pkgName, pkg] of resolver.workspacePackages) {
      if (importModule === pkgName || importModule.startsWith(pkgName + "/")) {
        const subpath =
          importModule === pkgName
            ? "."
            : "./" + importModule.slice(pkgName.length + 1);

        // Look up in exports map
        const exportTarget = pkg.exports[subpath];
        if (exportTarget) {
          const resolved = path.resolve(pkg.dir, exportTarget);
          return this.tryResolveWithExtensions(resolved, fileToHashes);
        }

        // Fallback: conventional src/ resolution
        if (subpath === ".") {
          return this.tryResolveWithExtensions(
            path.resolve(pkg.dir, "src/index"),
            fileToHashes,
          );
        } else {
          const srcFile = path.resolve(pkg.dir, "src", subpath.slice(2));
          return this.tryResolveWithExtensions(srcFile, fileToHashes);
        }
      }
    }

    // Case 3: Path alias imports (e.g. "@/components/ui/button")
    for (const [pkgDir, aliases] of resolver.pathAliases) {
      if (!importerFilePath.startsWith(pkgDir + "/")) continue;

      for (const [aliasPattern, targets] of Object.entries(aliases.paths)) {
        const hasStar = aliasPattern.endsWith("/*");
        const prefix = hasStar ? aliasPattern.slice(0, -1) : aliasPattern;

        if (hasStar && importModule.startsWith(prefix)) {
          const remainder = importModule.slice(prefix.length);
          for (const targetPattern of targets) {
            const targetBase = targetPattern.replace("/*", "/" + remainder);
            const resolved = path.resolve(aliases.baseUrl, targetBase);
            const result = this.tryResolveWithExtensions(resolved, fileToHashes);
            if (result) return result;
          }
        } else if (!hasStar && importModule === aliasPattern) {
          for (const targetPattern of targets) {
            const resolved = path.resolve(aliases.baseUrl, targetPattern);
            const result = this.tryResolveWithExtensions(resolved, fileToHashes);
            if (result) return result;
          }
        }
      }
    }

    return undefined;
  }
}
