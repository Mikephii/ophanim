import type Graph from "graphology";
import type { CommunityDetector, DetectorOptions, RawDetectionResult } from "./types";

/**
 * Label Propagation Algorithm (LPA) for community detection.
 *
 * Each node starts with a unique label. On each iteration, every node adopts
 * the label with the highest total edge weight among its neighbors. Ties are
 * broken randomly. Converges when no node changes its label.
 *
 * Pros: fast, no resolution parameter needed, finds natural cluster boundaries
 * Cons: non-deterministic, may produce different results on each run
 */
export class LabelPropDetector implements CommunityDetector {
  readonly name = "label-propagation";
  readonly supportsResolution = false;

  private maxIterations: number;

  constructor(maxIterations = 100) {
    this.maxIterations = maxIterations;
  }

  detect(graph: Graph, options: DetectorOptions): RawDetectionResult {
    // Initialize: each node gets a unique label
    const labels = new Map<string, number>();
    let nextLabel = 0;
    graph.forEachNode((node) => {
      labels.set(node, nextLabel++);
    });

    const nodes = graph.nodes();

    for (let iter = 0; iter < this.maxIterations; iter++) {
      let changed = false;

      // Shuffle nodes for random processing order (reduces bias)
      for (let i = nodes.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
      }

      for (const node of nodes) {
        // Sum weights per neighboring label
        const labelWeights = new Map<number, number>();
        graph.forEachEdge(node, (_edge, attrs, source, target) => {
          const neighbor = source === node ? target : source;
          const neighborLabel = labels.get(neighbor)!;
          const weight = (attrs[options.weightAttribute] as number) || 1.0;
          labelWeights.set(neighborLabel, (labelWeights.get(neighborLabel) || 0) + weight);
        });

        if (labelWeights.size === 0) continue;

        // Find label(s) with maximum weight
        let maxWeight = -Infinity;
        const candidates: number[] = [];
        for (const [label, weight] of labelWeights) {
          if (weight > maxWeight) {
            maxWeight = weight;
            candidates.length = 0;
            candidates.push(label);
          } else if (weight === maxWeight) {
            candidates.push(label);
          }
        }

        // Break ties randomly
        const chosen = candidates[Math.floor(Math.random() * candidates.length)];
        if (chosen !== labels.get(node)) {
          labels.set(node, chosen);
          changed = true;
        }
      }

      if (!changed) break;
    }

    // Convert to Record<string, number>
    const communities: Record<string, number> = {};
    for (const [node, label] of labels) {
      communities[node] = label;
    }
    return { communities, modularity: null };
  }
}
