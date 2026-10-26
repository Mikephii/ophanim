# Community Detection: A Practical Guide

This document explains how Ophan's graph-based community detection works, how to experiment with it, and how to tell when you've found good results. It's written for humans who will be tweaking parameters, comparing runs, and staring at community breakdowns trying to decide if the groupings make sense.

## What We're Actually Doing

Every function in your codebase has relationships to other functions -- it calls them, it lives in the same file, it imports them, it uses the same UI components. We build a graph where functions are nodes and these relationships are weighted edges, then we run a community detection algorithm to find natural clusters of closely-related functions.

The goal is to produce communities that a human would look at and say "yes, those belong together." A good community is one where every function in it makes sense alongside the others -- they work on the same feature, they live in the same module, they serve the same purpose. A bad community is one that makes you squint and wonder why `readCredentials` ended up next to `analyzeGraph`.

## The Two Algorithms: Louvain vs Leiden

We have two serious algorithms and one lightweight one. Understanding the difference matters because they produce meaningfully different results.

### Louvain

Louvain is the workhorse. It's deterministic (same input = same output), fast, and well-understood. It works by greedily moving nodes between communities to maximize a quality metric called modularity. It runs in passes -- first every node finds its best community, then it creates a new graph where communities become nodes, and repeats until nothing moves.

The resolution parameter controls how fine-grained the communities are. Higher resolution means the algorithm demands stronger evidence before putting two functions in the same community. At resolution 1.0, you'll get big communities; at resolution 3.0, you'll get many small ones.

Louvain's weakness is that it can produce internally disconnected communities. Imagine functions A-B-C and D-E-F that are each tightly connected internally but have no edges between them. Louvain might put all six in one community if they happen to be weakly connected to the same hub node. The community looks unified on paper but is actually two separate clusters wearing one label.

### Leiden

Leiden (Traag, van Eck & Waltman, 2019) was designed specifically to fix Louvain's disconnected community problem. It adds a "refinement" phase between the local moving and aggregation steps. After the initial community assignments, Leiden checks whether each community is actually internally connected. If it finds a community that's really two disconnected pieces, it splits them.

This matters in practice. When Louvain produces a community of 27 functions spanning 4 files, it might be because the functions are genuinely all related -- or it might be because the orchestration function `runAnalyze` calls into auth, sync, and graph, creating a false impression that auth.ts and graph.ts belong together. Leiden's refinement phase is more likely to recognize that those are separate clusters connected by a thin bridge.

Leiden is non-deterministic -- the processing order is randomized, so you'll get slightly different results each run. The communities will be structurally similar but may differ at the margins. This is fine for our use case (we're generating documentation, not building a bridge), but it means you shouldn't panic if two consecutive runs produce slightly different community counts.

Leiden also supports the resolution parameter with the same semantics as Louvain -- higher means more, smaller communities.

**Our default is Leiden at resolution 3.0.** We chose this after extensive comparison testing on the Ophan codebase itself. The combination of Leiden's connectivity guarantees and high resolution produced the cleanest file-boundary-respecting communities.

### Label Propagation

Label propagation is the simple one. Each node starts with its own label, then iteratively adopts the most common label among its neighbors (weighted by edge strength). It converges when no node wants to change. It doesn't have a resolution parameter -- it finds "natural" boundaries determined purely by the graph structure.

It's useful as a sanity check. If both Leiden and label propagation find roughly similar communities, the structure in your code is strong and real. If they disagree wildly, the communities are sensitive to the algorithm and you should look at your edge weights.

## The Seven Edge Types

The graph is only as good as its edges. Each edge type captures a different signal about how functions relate to each other, and the relative weights between them determine what the algorithm "sees."

### Direct Edges (extracted from source code)

**Call edges** (default weight: 0.5) are the most intuitive -- function A literally calls function B. This is the strongest signal of actual runtime dependency. If `validate()` calls `sanitizeInput()`, those two functions are directly coupled. Call edges don't include JSX component references (those are separate, explained below).

We set calls to 0.5 rather than the traditional 1.0 because in our codebase, orchestration functions like `runAnalyze` call into many different modules. At 1.0, these hub functions pulled everything they touched into one giant community. At 0.5, the call signal is still strong but doesn't overwhelm file proximity.

**Import edges** (default weight: 0.2) come from `import { thing } from "./file"` statements. When your file imports a specific function from another file, that's evidence of a relationship. Import edges go through module resolution -- relative imports, workspace package imports, and even path alias imports (`@/components/`) are all resolved to actual files.

We weight imports lower (0.2) because many imports are to shared utilities or UI components that don't indicate domain proximity. Importing `cn()` from `lib/utils.ts` doesn't mean your function belongs with the utility module.

**Co-location edges** (default weight: 0.7) are based purely on physical proximity. Functions in the same file are connected, with weight decaying by distance -- adjacent functions get the full weight, functions 5 positions apart get 1/5th. Functions in the same directory but different files also get edges, but at half the weight.

This is the main "respect file boundaries" knob. The developer who put functions A, B, and C in the same file probably did so because they're related. A weight of 0.7 means co-location is actually the strongest single signal -- stronger than a direct call (0.5). This keeps files together even when some functions reach across file boundaries to call into other modules.

**JSX reference edges** (default weight: 0.2) are for React component composition -- when a function renders `<Button />` or `<Card />`, it creates a weak edge to those components. JSX refs are deliberately separated from call edges because UI composition is a qualitatively different signal. Calling `validateEmail()` means your function does validation; rendering `<AlertDialog>` means your function has a confirmation step. The former is a strong domain signal, the latter is UI plumbing.

Without this separation, every function that uses `<Card>` would get pulled into one giant "Card users" community, obliterating actual domain boundaries.

### Derived Edges (computed in-memory, not stored)

**Transitive call edges** (default weight: 0.4) capture two-hop relationships. If A calls B and B calls C, we create an edge between A and C. The reasoning is that A and C are likely working on related things even though they don't directly interact -- they're part of the same call chain.

**Co-caller edges** (default weight: 0.4) capture a different pattern: if function A calls both B and C, we create an edge between B and C. They serve the same caller, so they likely participate in the same workflow. There's a cap at 15 callees per caller to prevent orchestration functions from generating an explosion of edges between unrelated utilities.

Both derived edge types stack with direct edges. If A and C have both a direct call edge (0.5) and a transitive edge (0.4), the merged weight is 0.9. Being related in multiple ways makes the connection stronger, which is the right behavior.

### Why These Weights?

The current weights were arrived at through iterative testing on the Ophan codebase (420 functions, ~13.5K edges). The key insight was that the original weight hierarchy (calls at 1.0, everything else lower) produced communities dominated by call relationships, which meant orchestration functions that call into many modules would drag everything into one cluster.

The current weights (co_location 0.7 > call 0.5 > transitive/co_caller 0.4 > import/jsx_ref 0.2) prioritize file structure first, then augment with runtime relationships. This produces communities that broadly follow file boundaries but can split a large file into multiple communities when the function-level relationships justify it, and can merge related functions across files when the connections are strong enough.

## Directory Decay

On top of edge weights, there's a spatial penalty applied to all cross-directory edges. Every edge between two functions in different directories gets its weight multiplied by `exp(-directoryDecay * distance)`, where distance is the number of directory hops between them.

At the default decay of 0.7, this is aggressive:

| Directory distance | Weight multiplier | What this means |
|---|---|---|
| 0 (same directory) | 100% | No penalty -- same-file and same-dir are full strength |
| 2 (sibling directories) | 25% | Cross-directory edges are already quite weak |
| 4 (cross-package) | 6% | Basically background noise |
| 7 (deep cross-package) | 0.7% | Essentially zero |

This is a strong signal to "stay in your directory." It's the main reason we don't see functions from `packages/core/` ending up in communities with functions from `packages/webapp/`. It also helps break up that common failure mode where an orchestration function in `cli/src/index.ts` calls into `core/src/graph.ts` and all the graph functions get dragged into the CLI community.

If you're analyzing a codebase where directory structure doesn't reflect logical boundaries (e.g., everything in one flat `src/` directory), you'll want to lower this significantly or set it to 0.

## How To Experiment

### The Quick Start

Run the default:
```bash
pnpm dev graph --path /path/to/repo
```

Read the output. Scroll through the community breakdown. Ask yourself: do these groupings make sense? Are functions that work together actually together? Are there communities that make you squint?

### The Comparison Tool

The fastest way to explore the parameter space:
```bash
pnpm dev graph --compare --path .
```

This runs the same graph through 7 different algorithm/resolution configurations and prints a metrics table:

```
  Algorithm Comparison (411 nodes, 13525 edges)

  Configuration          Communities  Dissolved  Coverage  Min  Med  Max  Modularity
  ──────────────────────────────────────────────────────────────────────────────────
  louvain@1.0                    72     1 (0%)     100%    2    5   14     0.72
  louvain@1.5                    99     1 (0%)     100%    2    3   18     0.65
  louvain@2.0                   105     1 (0%)     100%    2    3   18     0.61
  louvain@3.0                   112     1 (0%)     100%    2    3   13     0.56
  label-propagation              28     0 (0%)     100%    2   12   42       ---
  leiden@1.5                     74     1 (0%)     100%    2    5   18     0.18
  leiden@2.0                     88     1 (0%)     100%    2    4   15     0.17
```

The columns tell you:
- **Communities**: How many groups the algorithm found. More isn't always better.
- **Dissolved**: Functions that couldn't be placed in any community. High dissolved counts mean the algorithm is fragmenting your code.
- **Coverage**: Percentage of functions actually placed in communities. You want this close to 100%.
- **Min/Med/Max**: Community size distribution. A max of 42 probably means you have a grab-bag community. A min of 2 with median of 3 might mean things are over-fragmented.
- **Modularity**: The algorithm's own confidence score (0-1). Higher means cleaner separation. But don't chase modularity -- a modularity of 0.7 with nonsensical communities is worse than 0.5 with sensible ones.

Add `--json` for machine-readable output you can pipe into analysis tools.

### Individual Runs

Override specific parameters to test hypotheses:

```bash
# Try Leiden at higher resolution
pnpm dev graph --algorithm leiden --resolution 3.0 --path .

# Try Louvain with same settings for comparison
pnpm dev graph --algorithm louvain --resolution 3.0 --path .

# Restrict community size
pnpm dev graph --algorithm leiden --resolution 3.0 --max-size 12 --path .

# Require larger minimum communities
pnpm dev graph --algorithm leiden --resolution 3.0 --min-size 4 --path .

# Aggressive directory penalty
pnpm dev graph --algorithm leiden --resolution 3.0 --directory-decay 0.9 --path .

# Combine everything
pnpm dev graph --algorithm leiden --resolution 3.0 --max-size 18 --min-size 3 --directory-decay 0.7 --path .
```

### Changing Edge Weights

Edge weights aren't exposed as CLI flags because there are 7 of them and they interact in non-obvious ways. Instead, edit the `DEFAULT_EDGE_WEIGHTS` constant in `packages/core/src/graph.ts`. Each weight has a doc comment explaining what it does and the effect of increasing or decreasing it.

After changing weights, run `--compare` to see the impact across all algorithms simultaneously. This is the fastest feedback loop: change a weight, run compare, look at the table, decide if it's better or worse.

The weights are saved to the repo's `.ophan/index.db` on each run, so your settings persist. But the `DEFAULT_EDGE_WEIGHTS` in code is what new repos or fresh runs will use.

## What Good Results Look Like

After running enough comparisons, you develop an eye for what "good" means. Here's what to look for.

### Single-File Communities

The clearest win is when all functions in a file end up in the same community. If `sidebar.tsx` has 19 exported components and they're all in Community 55, that's correct. A file is a deliberate organizational unit -- the developer put those functions together for a reason.

Look at the community breakdown and check: are there communities where every function comes from the same file? The more of these you see, the better your weights are calibrated.

### Logical Groupings Across Files

Sometimes the algorithm should combine functions across files. If `sync.ts`, `sync.test.ts`, and the related test utilities all end up in one community, that's often correct -- they're a logical unit even though they span multiple files. Same for a route page and its closely-used components.

The judgment call is: would you explain these functions together? If a new team member asked "what does this community do?" and the answer is coherent ("it handles syncing to Supabase"), it's a good community regardless of how many files it spans.

### The Extension Test

Large files with multiple concerns should get split. The VS Code extension (`packages/vscode/src/extension.ts`) has activation logic, database management, diagnostics, webview panels, hover providers, and configuration getters. A good result splits these into 4-6 focused communities, each representing a distinct concern within the file.

If the extension is a single 30-function community, the resolution is too low. If it's fragmented into 15 tiny communities, the resolution is too high or co-location weight is too low.

### Red Flags

**The Grab-Bag Community**: A community of 20+ functions from many different files and packages with no obvious theme. This usually means a widely-used utility or UI component (Card, Button, cn()) is acting as a gravitational center, pulling in everything that uses it. Fix by lowering the call or jsx_ref weight, or increasing co_location weight so file proximity wins.

**Cross-Package Leakage**: Functions from `packages/webapp/` ending up in the same community as functions from `packages/vscode/`. These packages should almost never share a community. Fix by increasing directory decay (the default 0.7 is already aggressive, but you might need 0.8-0.9 for extreme cases).

**Orchestration Contamination**: An orchestration function like `runAnalyze()` calls into auth, sync, graph, and analysis modules. If all those modules end up in one community because of that one function, the call weight is too high relative to co-location. The fix is either lower call weight, higher co-location weight, or higher directory decay.

**Over-Fragmentation**: Dozens of size-2 and size-3 communities with many dissolved functions. The algorithm is cutting too aggressively. Fix by lowering resolution, lowering min-size, or increasing co-location weight.

**The Empty Promise of Modularity**: A high modularity score (>0.7) doesn't automatically mean good communities. Modularity measures how well the partition separates the graph, not whether the resulting groups are semantically meaningful. Always look at the actual community breakdown, not just the number.

## The Tuning Workflow

When you're trying to improve community detection results, here's the workflow that works:

1. **Start with `--compare`** to see the landscape. Look at how different resolutions affect the metrics. Identify which algorithm/resolution range gives the best balance of community count, size distribution, and coverage.

2. **Run your best candidate** with the full output and read every community. Mark the ones that look wrong -- too big, too mixed, cross-package leakage, etc.

3. **Diagnose the pattern**:
   - Too many grab-bag communities → lower call weight, raise co_location
   - Cross-package leakage → raise directory decay
   - File boundaries not respected → raise co_location
   - Natural clusters being split → lower resolution or raise max-size
   - One giant community that won't split → raise resolution, the quality gate may be protecting it

4. **Make ONE change at a time** and re-run. Changing multiple parameters simultaneously makes it impossible to know what helped and what hurt.

5. **Use `--compare` after each change** to verify you didn't break other metrics while fixing the target problem.

6. **Accept imperfection**. Community detection on code graphs is a heuristic. You will never get 100% of communities looking perfect. The goal is "most communities are sensible and the few weird ones are small." If 50 out of 58 communities are clean, that's a win.

## Current Defaults

These were tuned on the Ophan codebase itself (420 functions, 13.5K edges) and produce good results on TypeScript monorepos with separate packages:

```
algorithm:      leiden
resolution:     3.0
minCommunitySize: 3
maxCommunitySize: 18
directoryDecay: 0.7

Edge weights:
  co_location:     0.7  (strongest -- files cluster together)
  call:            0.5  (direct calls)
  transitive_call: 0.4  (two-hop call chains)
  co_caller:       0.4  (shared callers)
  import:          0.2  (import statements)
  jsx_ref:         0.2  (JSX component references)
  type_ref:        0.5  (not yet extracted)
```

These are not universal. A flat single-package codebase would need lower directory decay. A codebase without React would have no jsx_ref edges and might want higher import weight. A codebase with very large files might need higher resolution and lower max-size.

## Key Files

- `packages/core/src/graph.ts` -- `DEFAULT_EDGE_WEIGHTS` (line ~67), `DEFAULT_GRAPH_CONFIG` (line ~134), all graph logic
- `packages/core/src/community-detectors/` -- Algorithm implementations: `louvain.ts`, `leiden.ts`, `label-prop.ts`
- `packages/cli/src/index.ts` -- CLI flag definitions for the `graph` command
- `packages/core/src/graph.test.ts` -- Tests covering all graph behavior
