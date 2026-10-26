import type { EdgeResolver, EdgeResolverContext } from "./types";
import type { FunctionEdge } from "../graph";
import { getModuleResolverForFile } from "../module-resolvers";

/**
 * Resolves import edges from import statements.
 * Three resolution paths:
 * 1. Direct: imported name found in the resolved target file
 * 2. Barrel fallback: imported name found via package-scoped search (re-exports)
 * 3. Namespace fallback: intersect fn.calls with target file's functions
 *
 * Owns importAdded Set for deduplication (import edges are undirected).
 */
export class ImportEdgeResolver implements EdgeResolver {
  readonly edgeTypes = ["import"] as const;

  resolve(ctx: EdgeResolverContext): FunctionEdge[] {
    const edges: FunctionEdge[] = [];
    const importAdded = new Set<string>();

    for (const fn of ctx.functions) {
      if (ctx.affectedHashes && !ctx.affectedHashes.has(fn.contentHash)) continue;
      if (!fn.imports) continue;

      for (const imp of fn.imports) {
        const langResolver = getModuleResolverForFile(fn.filePath);
        const targetFile = langResolver?.resolveModuleToFile(
          imp.module,
          fn.filePath,
          ctx.fileToHashes,
          ctx.resolver,
        );

        // Determine package scope for fallback through barrel file re-exports
        let pkgScope: Map<string, Set<string>> | undefined;
        if (ctx.resolver) {
          for (const [pkgName] of ctx.resolver.workspacePackages) {
            if (
              imp.module === pkgName ||
              imp.module.startsWith(pkgName + "/")
            ) {
              pkgScope = ctx.pkgNameToHashes.get(pkgName);
              break;
            }
          }
        }

        if (!targetFile && !pkgScope) continue;

        // Create edges to the specific functions named in the import
        let matched = false;
        for (const importedName of imp.names) {
          // Direct lookup: function defined in the resolved target file
          const directHash = targetFile
            ? ctx.fileNameToHash.get(`${targetFile}::${importedName}`)
            : undefined;

          if (directHash && directHash !== fn.contentHash) {
            matched = true;
            const a = fn.contentHash < directHash ? fn.contentHash : directHash;
            const b = fn.contentHash < directHash ? directHash : fn.contentHash;
            const importKey = `${a}|${b}`;
            if (!importAdded.has(importKey)) {
              importAdded.add(importKey);
              edges.push({
                sourceHash: a,
                targetHash: b,
                edgeType: "import",
                weight: ctx.config.edgeWeights.import,
              });
            }
          } else if (pkgScope) {
            // Fallback: imported name is a re-export through a barrel file
            const targetHashes = pkgScope.get(importedName);
            if (targetHashes) {
              for (const targetHash of targetHashes) {
                if (targetHash === fn.contentHash) continue;
                matched = true;
                const a =
                  fn.contentHash < targetHash ? fn.contentHash : targetHash;
                const b =
                  fn.contentHash < targetHash ? targetHash : fn.contentHash;
                const importKey = `${a}|${b}`;
                if (!importAdded.has(importKey)) {
                  importAdded.add(importKey);
                  edges.push({
                    sourceHash: a,
                    targetHash: b,
                    edgeType: "import",
                    weight: ctx.config.edgeWeights.import,
                  });
                }
              }
            }
          }
        }

        // Fallback for namespace imports: intersect fn.calls with target file's functions
        if (!matched && fn.calls && targetFile) {
          const targetFnsInFile = ctx.fileToHashes.get(targetFile);
          if (targetFnsInFile) {
            for (const calledName of fn.calls) {
              const targetHash = ctx.fileNameToHash.get(
                `${targetFile}::${calledName}`,
              );
              if (
                targetHash &&
                targetHash !== fn.contentHash &&
                targetFnsInFile.has(targetHash)
              ) {
                const a =
                  fn.contentHash < targetHash ? fn.contentHash : targetHash;
                const b =
                  fn.contentHash < targetHash ? targetHash : fn.contentHash;
                const importKey = `${a}|${b}`;
                if (!importAdded.has(importKey)) {
                  importAdded.add(importKey);
                  edges.push({
                    sourceHash: a,
                    targetHash: b,
                    edgeType: "import",
                    weight: ctx.config.edgeWeights.import,
                  });
                }
              }
            }
          }
        }
      }
    }

    return edges;
  }
}
