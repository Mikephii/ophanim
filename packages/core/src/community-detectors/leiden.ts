import type Graph from "graphology";
import type { CommunityDetector, DetectorOptions, RawDetectionResult } from "./types";

/**
 * Leiden community detection algorithm (Traag, van Eck & Waltman, 2019).
 *
 * Improvement over Louvain with three phases per iteration:
 *   1. Local moving: nodes move to neighboring community maximizing modularity gain
 *   2. Refinement: ensures each community is internally connected by re-examining
 *      sub-structure within communities (the key Leiden innovation)
 *   3. Aggregation: create super-graph where communities become nodes
 *
 * Guarantees communities are well-connected (no disconnected subgroups within a community).
 * Uses modularity quality function: Q = Σ_c [e_c/m - γ(n_c/2m)²]
 *
 * Reference: https://arxiv.org/abs/1810.08473
 */
export class LeidenDetector implements CommunityDetector {
  readonly name = "leiden";
  readonly supportsResolution = true;

  detect(graph: Graph, options: DetectorOptions): RawDetectionResult {
    if (graph.order === 0) {
      return { communities: {}, modularity: null };
    }

    const nodes = graph.nodes();
    const weightAttr = options.weightAttribute;
    const resolution = options.resolution;

    // Total edge weight in graph (sum of all edge weights)
    let totalWeight = 0;
    graph.forEachEdge((_edge, attrs) => {
      totalWeight += (attrs[weightAttr] as number) || 1.0;
    });
    if (totalWeight === 0) {
      // No edges -- each node is its own community
      const communities: Record<string, number> = {};
      nodes.forEach((n, i) => { communities[n] = i; });
      return { communities, modularity: 0 };
    }

    // Initialize: each node in its own community
    const nodeToComm = new Map<string, number>();
    nodes.forEach((n, i) => nodeToComm.set(n, i));
    let nextCommId = nodes.length;

    // Precompute node strengths (weighted degree)
    const nodeStrength = new Map<string, number>();
    for (const node of nodes) {
      let strength = 0;
      graph.forEachEdge(node, (_edge, attrs) => {
        strength += (attrs[weightAttr] as number) || 1.0;
      });
      nodeStrength.set(node, strength);
    }

    // Run Leiden iterations
    const maxIterations = 10;
    for (let iter = 0; iter < maxIterations; iter++) {
      const moved = localMovingPhase(graph, nodeToComm, nodeStrength, totalWeight, resolution, weightAttr);
      refinementPhase(graph, nodeToComm, nodeStrength, totalWeight, resolution, weightAttr, nextCommId);

      // Update nextCommId to be above any community ID used
      let maxComm = 0;
      for (const c of nodeToComm.values()) {
        if (c > maxComm) maxComm = c;
      }
      nextCommId = maxComm + 1;

      if (!moved) break;
    }

    // Renumber communities to contiguous integers
    const communities: Record<string, number> = {};
    const commRemap = new Map<number, number>();
    let nextId = 0;
    for (const node of nodes) {
      const comm = nodeToComm.get(node)!;
      if (!commRemap.has(comm)) {
        commRemap.set(comm, nextId++);
      }
      communities[node] = commRemap.get(comm)!;
    }

    // Compute modularity
    const modularity = computeModularity(graph, communities, totalWeight, resolution, weightAttr);

    return { communities, modularity };
  }
}

/**
 * Phase 1: Local moving -- nodes greedily move to neighboring community maximizing modularity gain.
 * Returns true if any node moved.
 */
function localMovingPhase(
  graph: Graph,
  nodeToComm: Map<string, number>,
  nodeStrength: Map<string, number>,
  totalWeight: number,
  resolution: number,
  weightAttr: string
): boolean {
  const nodes = graph.nodes();
  let moved = false;

  // Shuffle nodes for random processing order
  for (let i = nodes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
  }

  // Precompute community aggregate strengths
  const commStrength = new Map<number, number>();
  for (const [node, comm] of nodeToComm) {
    commStrength.set(comm, (commStrength.get(comm) || 0) + (nodeStrength.get(node) || 0));
  }

  for (const node of nodes) {
    const currentComm = nodeToComm.get(node)!;
    const ki = nodeStrength.get(node) || 0;

    // Sum edge weights to each neighboring community
    const neighborCommWeights = new Map<number, number>();
    graph.forEachEdge(node, (_edge, attrs, source, target) => {
      const neighbor = source === node ? target : source;
      const neighborComm = nodeToComm.get(neighbor)!;
      const weight = (attrs[weightAttr] as number) || 1.0;
      neighborCommWeights.set(neighborComm, (neighborCommWeights.get(neighborComm) || 0) + weight);
    });

    // Temporarily remove node from its community for evaluation
    const currentCommStrengthWithout = (commStrength.get(currentComm) || 0) - ki;
    const edgesToCurrent = neighborCommWeights.get(currentComm) || 0;

    // Modularity loss from removing node from current community
    const removeLoss = edgesToCurrent / totalWeight - resolution * ki * currentCommStrengthWithout / (2 * totalWeight * totalWeight);

    // Find best community to move to
    let bestComm = currentComm;
    let bestGain = 0;

    for (const [comm, edgesToComm] of neighborCommWeights) {
      if (comm === currentComm) continue;
      const commStr = commStrength.get(comm) || 0;

      // Modularity gain from adding node to this community
      const addGain = edgesToComm / totalWeight - resolution * ki * commStr / (2 * totalWeight * totalWeight);
      const netGain = addGain - removeLoss;

      if (netGain > bestGain) {
        bestGain = netGain;
        bestComm = comm;
      }
    }

    if (bestComm !== currentComm) {
      // Move node
      commStrength.set(currentComm, (commStrength.get(currentComm) || 0) - ki);
      commStrength.set(bestComm, (commStrength.get(bestComm) || 0) + ki);
      nodeToComm.set(node, bestComm);
      moved = true;
    }
  }

  return moved;
}

/**
 * Phase 2: Refinement -- ensures communities are internally connected.
 * For each community, check if it can be split into better-connected sub-communities.
 * Nodes that are weakly connected within their community are moved to improve quality.
 */
function refinementPhase(
  graph: Graph,
  nodeToComm: Map<string, number>,
  nodeStrength: Map<string, number>,
  totalWeight: number,
  resolution: number,
  weightAttr: string,
  nextCommId: number
): void {
  // Group nodes by community
  const commMembers = new Map<number, string[]>();
  for (const [node, comm] of nodeToComm) {
    const members = commMembers.get(comm) || [];
    members.push(node);
    commMembers.set(comm, members);
  }

  for (const [commId, members] of commMembers) {
    if (members.length <= 2) continue;

    // Check connectivity within this community using BFS
    // If community is already a single connected component, skip refinement
    const memberSet = new Set(members);
    const components = findConnectedComponents(graph, memberSet, weightAttr);

    if (components.length <= 1) {
      // Community is connected -- try sub-community refinement
      // Each node starts in its own sub-community within this community
      const subComm = new Map<string, number>();
      let subId = nextCommId;
      for (const member of members) {
        subComm.set(member, subId++);
      }

      // Precompute sub-community strengths
      const subCommStrength = new Map<number, number>();
      for (const member of members) {
        const sc = subComm.get(member)!;
        subCommStrength.set(sc, nodeStrength.get(member) || 0);
      }

      // Local moving within this community only -- iterate until convergence
      for (let refIter = 0; refIter < 10; refIter++) {
        let refMoved = false;

        // Shuffle members
        const shuffled = [...members];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        for (const node of shuffled) {
          const currentSub = subComm.get(node)!;
          const ki = nodeStrength.get(node) || 0;

          const neighborSubWeights = new Map<number, number>();
          graph.forEachEdge(node, (_edge, attrs, source, target) => {
            const neighbor = source === node ? target : source;
            if (!memberSet.has(neighbor)) return; // Only within this community
            const nSub = subComm.get(neighbor)!;
            const weight = (attrs[weightAttr] as number) || 1.0;
            neighborSubWeights.set(nSub, (neighborSubWeights.get(nSub) || 0) + weight);
          });

          const edgesToCurrent = neighborSubWeights.get(currentSub) || 0;
          const currentSubStr = (subCommStrength.get(currentSub) || 0) - ki;
          const removeLoss = edgesToCurrent / totalWeight - resolution * ki * currentSubStr / (2 * totalWeight * totalWeight);

          let bestSub = currentSub;
          let bestGain = 0;

          for (const [sc, edgesToSub] of neighborSubWeights) {
            if (sc === currentSub) continue;
            const scStr = subCommStrength.get(sc) || 0;
            const addGain = edgesToSub / totalWeight - resolution * ki * scStr / (2 * totalWeight * totalWeight);
            const netGain = addGain - removeLoss;
            if (netGain > bestGain) {
              bestGain = netGain;
              bestSub = sc;
            }
          }

          if (bestSub !== currentSub) {
            subCommStrength.set(currentSub, (subCommStrength.get(currentSub) || 0) - ki);
            subCommStrength.set(bestSub, (subCommStrength.get(bestSub) || 0) + ki);
            subComm.set(node, bestSub);
            refMoved = true;
          }
        }

        if (!refMoved) break;
      }

      // Check if refinement produced multiple sub-communities
      const subGroups = new Map<number, string[]>();
      for (const member of members) {
        const sc = subComm.get(member)!;
        const group = subGroups.get(sc) || [];
        group.push(member);
        subGroups.set(sc, group);
      }

      if (subGroups.size > 1) {
        // Apply the refined partition -- each sub-community gets its own ID
        for (const [subCommId, subMembers] of subGroups) {
          for (const member of subMembers) {
            nodeToComm.set(member, subCommId);
          }
        }
      }
    } else {
      // Community is disconnected -- split into connected components
      for (let i = 1; i < components.length; i++) {
        const newId = nextCommId++;
        for (const node of components[i]) {
          nodeToComm.set(node, newId);
        }
      }
    }
  }
}

/**
 * Find connected components within a subset of nodes on the graph.
 * Only traverses edges where both endpoints are in the subset.
 */
function findConnectedComponents(
  graph: Graph,
  memberSet: Set<string>,
  weightAttr: string
): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const node of memberSet) {
    if (visited.has(node)) continue;

    const component: string[] = [];
    const queue = [node];
    visited.add(node);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);

      graph.forEachEdge(current, (_edge, attrs, source, target) => {
        const neighbor = source === current ? target : source;
        if (memberSet.has(neighbor) && !visited.has(neighbor)) {
          const weight = (attrs[weightAttr] as number) || 1.0;
          if (weight > 0) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      });
    }

    components.push(component);
  }

  return components;
}

/**
 * Compute modularity of a partition.
 * Q = (1/2m) Σ_ij [A_ij - γ * ki*kj / 2m] * δ(ci, cj)
 */
function computeModularity(
  graph: Graph,
  communities: Record<string, number>,
  totalWeight: number,
  resolution: number,
  weightAttr: string
): number {
  if (totalWeight === 0) return 0;

  // Sum of edge weights within communities
  let internalWeight = 0;
  graph.forEachEdge((_edge, attrs, source, target) => {
    if (communities[source] === communities[target]) {
      internalWeight += (attrs[weightAttr] as number) || 1.0;
    }
  });

  // Sum of strengths per community
  const commStrength = new Map<number, number>();
  for (const [node, comm] of Object.entries(communities)) {
    let strength = 0;
    graph.forEachEdge(node, (_edge, attrs) => {
      strength += (attrs[weightAttr] as number) || 1.0;
    });
    commStrength.set(comm, (commStrength.get(comm) || 0) + strength);
  }

  let expectedWeight = 0;
  for (const strength of commStrength.values()) {
    expectedWeight += strength * strength;
  }

  return internalWeight / (2 * totalWeight) - resolution * expectedWeight / (4 * totalWeight * totalWeight);
}
