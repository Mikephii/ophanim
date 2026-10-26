import type Graph from "graphology";

/**
 * Raw output from a community detection algorithm.
 * Maps node IDs to integer community labels. Post-processing (dissolution,
 * splitting, rescue, stable matching) is handled by detectCommunities().
 */
export interface RawDetectionResult {
  /** Node ID → community label */
  communities: Record<string, number>;
  /** Modularity score (null if the algorithm doesn't compute it) */
  modularity: number | null;
}

/**
 * Options passed to a detector's detect() method.
 */
export interface DetectorOptions {
  /** Louvain resolution parameter (ignored by algorithms that don't support it) */
  resolution: number;
  /** Edge weight attribute name on the graphology graph */
  weightAttribute: string;
}

/**
 * Strategy interface for community detection algorithms.
 * Implementations wrap a specific algorithm (Louvain, label propagation, etc.)
 * and produce raw community assignments. All post-processing is algorithm-agnostic
 * and stays in detectCommunities().
 */
export interface CommunityDetector {
  /** Algorithm identifier (e.g., "louvain", "label-propagation") */
  readonly name: string;
  /** Whether this algorithm uses the resolution parameter */
  readonly supportsResolution: boolean;
  /** Run community detection on the given graph */
  detect(graph: Graph, options: DetectorOptions): RawDetectionResult;
}
