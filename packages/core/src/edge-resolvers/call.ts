import type { EdgeResolver, EdgeResolverContext } from "./types";
import type { FunctionEdge } from "../graph";

/**
 * Resolves direct function call edges.
 * For each function's calls[] array, looks up callee names in the name→hash index.
 * Creates edges from caller to all matching callees (handles name collisions).
 * Self-calls are skipped.
 */
export class CallEdgeResolver implements EdgeResolver {
  readonly edgeTypes = ["call"] as const;

  resolve(ctx: EdgeResolverContext): FunctionEdge[] {
    const edges: FunctionEdge[] = [];
    for (const fn of ctx.functions) {
      if (ctx.affectedHashes && !ctx.affectedHashes.has(fn.contentHash)) continue;
      if (!fn.calls) continue;
      for (const calledName of fn.calls) {
        const targetHashes = ctx.nameToHashes.get(calledName);
        if (!targetHashes) continue;
        for (const targetHash of targetHashes) {
          if (targetHash === fn.contentHash) continue;
          edges.push({
            sourceHash: fn.contentHash,
            targetHash,
            edgeType: "call",
            weight: ctx.config.edgeWeights.call,
          });
        }
      }
    }
    return edges;
  }
}
