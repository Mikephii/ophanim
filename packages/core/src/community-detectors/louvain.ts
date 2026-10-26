import type Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { CommunityDetector, DetectorOptions, RawDetectionResult } from "./types";

/**
 * Louvain community detection via graphology-communities-louvain.
 * Deterministic, fast, returns modularity score. Resolution parameter
 * controls granularity (higher = more, smaller communities).
 */
export class LouvainDetector implements CommunityDetector {
  readonly name = "louvain";
  readonly supportsResolution = true;

  detect(graph: Graph, options: DetectorOptions): RawDetectionResult {
    const result = louvain.detailed(graph, {
      resolution: options.resolution,
      getEdgeWeight: options.weightAttribute,
    });
    return {
      communities: result.communities as Record<string, number>,
      modularity: result.modularity,
    };
  }
}
