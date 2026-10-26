import type { EdgeResolver, EdgeResolverContext } from "./types";
import type { FunctionEdge } from "../graph";

/**
 * Resolves co-location edges -- proximity-based connections between functions
 * in the same file.
 *
 * All-pairs within each file, with weight decaying by positional distance (1/offset).
 * Adjacent functions get full weight; distance N gets weight/N.
 *
 * Cross-file relationships are captured by import, call, and jsx_ref edges -- not by
 * directory proximity, which produces O(n²) noise edges in large directories.
 */
export class CoLocationEdgeResolver implements EdgeResolver {
  readonly edgeTypes = ["co_location"] as const;

  resolve(ctx: EdgeResolverContext): FunctionEdge[] {
    const edges: FunctionEdge[] = [];
    const colocAdded = new Set<string>();

    for (const fn of ctx.functions) {
      if (ctx.affectedHashes && !ctx.affectedHashes.has(fn.contentHash)) continue;

      const sortedSiblings = ctx.fileToSortedFns.get(fn.filePath);
      if (!sortedSiblings || sortedSiblings.length <= 1) continue;

      const idx = sortedSiblings.indexOf(fn);
      if (idx < 0) continue;

      for (let offset = 1; offset < sortedSiblings.length - idx; offset++) {
        const neighbor = sortedSiblings[idx + offset];
        if (!neighbor) break;
        const a =
          fn.contentHash < neighbor.contentHash
            ? fn.contentHash
            : neighbor.contentHash;
        const b =
          fn.contentHash < neighbor.contentHash
            ? neighbor.contentHash
            : fn.contentHash;
        const key = `${a}|${b}`;
        if (!colocAdded.has(key)) {
          colocAdded.add(key);
          edges.push({
            sourceHash: a,
            targetHash: b,
            edgeType: "co_location",
            weight: ctx.config.edgeWeights.co_location / offset,
          });
        }
      }
    }

    return edges;
  }
}
