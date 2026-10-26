import type { FunctionInfo } from "../shared";
import type { GraphConfig, FunctionEdge, ModuleResolver } from "../graph";

/**
 * Shared context built once per resolveEdges() invocation.
 * Contains pre-built lookup maps that edge resolvers need.
 * The orchestrator builds this -- resolvers consume it.
 */
export interface EdgeResolverContext {
  /** function_name → Set<content_hash> (handles name collisions across files) */
  nameToHashes: Map<string, Set<string>>;
  /** file_path → Set<content_hash> */
  fileToHashes: Map<string, Set<string>>;
  /** "file_path::function_name" → content_hash (targeted import lookup) */
  fileNameToHash: Map<string, string>;
  /** package_name → Map<function_name, Set<content_hash>> (barrel file fallback) */
  pkgNameToHashes: Map<string, Map<string, Set<string>>>;
  /** file_path → FunctionInfo[] sorted by startLine */
  fileToSortedFns: Map<string, FunctionInfo[]>;
  /** All extracted functions for this scan */
  functions: FunctionInfo[];
  /** Graph configuration (edge weights, etc.) */
  config: GraphConfig;
  /** Optional: limit resolution to these hashes (incremental mode) */
  affectedHashes?: Set<string>;
  /** Optional: workspace module resolver for import resolution */
  resolver?: ModuleResolver;
}

/**
 * Strategy interface for edge resolution.
 * Each implementation handles one category of edges (calls, imports, co-location, etc.).
 *
 * Resolvers own their own deduplication -- the orchestrator concatenates results.
 */
export interface EdgeResolver {
  /** Edge type identifier(s) this resolver produces */
  readonly edgeTypes: readonly string[];
  /** Resolve edges from the shared context */
  resolve(ctx: EdgeResolverContext): FunctionEdge[];
}
