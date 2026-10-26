export type { CommunityDetector, RawDetectionResult, DetectorOptions } from "./types";
export { LouvainDetector } from "./louvain";
export { LabelPropDetector } from "./label-prop";
export { LeidenDetector } from "./leiden";

import type { CommunityDetector } from "./types";
import { LouvainDetector } from "./louvain";
import { LabelPropDetector } from "./label-prop";
import { LeidenDetector } from "./leiden";

const registry = new Map<string, CommunityDetector>();

/**
 * Register a community detection algorithm.
 * Call before detectCommunities() to make the algorithm available via GraphConfig.algorithm.
 */
export function registerDetector(detector: CommunityDetector): void {
  registry.set(detector.name, detector);
}

/**
 * Get a registered detector by name.
 * Throws if the algorithm is not registered.
 */
export function getDetector(name: string): CommunityDetector {
  const detector = registry.get(name);
  if (!detector) {
    const available = [...registry.keys()].join(", ");
    throw new Error(`Unknown community detection algorithm: "${name}". Available: ${available}`);
  }
  return detector;
}

/**
 * List all registered detector names.
 */
export function listDetectors(): string[] {
  return [...registry.keys()];
}

// Register built-in detectors
registerDetector(new LouvainDetector());
registerDetector(new LabelPropDetector());
registerDetector(new LeidenDetector());
