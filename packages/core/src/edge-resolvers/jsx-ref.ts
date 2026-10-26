import type { EdgeResolver, EdgeResolverContext } from "./types";
import type { FunctionEdge } from "../graph";

/**
 * Resolves JSX component reference edges.
 * When a function renders <Component />, creates a weak edge to that component.
 * Separated from call edges because UI composition is a weaker domain signal
 * than direct function calls.
 */
export class JsxRefEdgeResolver implements EdgeResolver {
  readonly edgeTypes = ["jsx_ref"] as const;

  resolve(ctx: EdgeResolverContext): FunctionEdge[] {
    const edges: FunctionEdge[] = [];
    for (const fn of ctx.functions) {
      if (ctx.affectedHashes && !ctx.affectedHashes.has(fn.contentHash)) continue;
      if (!fn.jsxRefs) continue;
      for (const refName of fn.jsxRefs) {
        const targetHashes = ctx.nameToHashes.get(refName);
        if (!targetHashes) continue;
        for (const targetHash of targetHashes) {
          if (targetHash === fn.contentHash) continue;
          edges.push({
            sourceHash: fn.contentHash,
            targetHash,
            edgeType: "jsx_ref",
            weight: ctx.config.edgeWeights.jsx_ref,
          });
        }
      }
    }
    return edges;
  }
}
