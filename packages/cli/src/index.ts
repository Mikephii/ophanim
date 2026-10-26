// @ophan/cli -- Command-line orchestration layer
// Shebang (#!/usr/bin/env node) is added by esbuild banner -- not in source.
//
// Architecture:
//   The CLI is a thin orchestration layer over @ophan/core. It owns the user-facing
//   commands (analyze, gc, sync) and progress reporting, but delegates all analysis,
//   parsing, hashing, and DB operations to the core package.
//
//   The CLI is IDE-agnostic -- it works the same whether the user has VS Code, JetBrains,
//   or no IDE at all. It creates .ophan/index.db which any IDE extension can read.
//
//   Language support is driven by core's extractFunctions() -- when core gains Python/Go/Java
//   parsers, the CLI automatically supports those languages with no changes needed here.
//   The file glob pattern and language detection live in core, not in the CLI.

import "dotenv/config";
import { Command } from "commander";
import {
  analyzeRepository, refreshFileIndex, gcAnalysis, ensureGitignore, initDb, findMissingHashes,
  extractAllFunctions, populateFileIndex, buildFunctionGraph, detectHierarchicalCommunities, loadGraphConfig, saveGraphConfig, loadCommunities, loadCommunityEdges,
  summarizeCommunities, loadAllSummaries,
  resolveEdges, storeEdges, buildModuleResolver, addTransitiveEdges, runComparison, DEFAULT_COMPARISONS,
  DEFAULT_GRAPH_CONFIG, type GraphConfig,
} from "@ophan/core";
import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import { login, deleteCredentials, readCredentials, getAuthenticatedClient } from "./auth";
import { NoServerConfiguredError, readSavedServer, requireServerConfig, resolveServerConfig, saveServer } from "./server";
import { syncToSupabase, pullFromSupabase, getGitBranch, getDefaultBranch } from "./sync";
import { startWatch } from "./watch";

const program = new Command();

program
  .name("ophan")
  .description("AI-powered code security analysis")
  // Replaced with the package version by esbuild; "dev" under tsx.
  .version(process.env.OPHAN_CLI_VERSION ?? "dev");

/**
 * Try to create a pull function for cloud sync.
 * Returns undefined if no server is configured, the user isn't logged in, or the repo
 * doesn't exist on the server. Silent -- never fails the analyze command.
 */
async function createPullFn(
  rootPath: string,
  onProgress?: (step: string) => void,
): Promise<((hashes: string[]) => Promise<void>) | undefined> {
  const creds = readCredentials();
  if (!creds) return undefined;

  try {
    const server = await resolveServerConfig();
    if (!server) return undefined;
    const { supabase, userId } = await getAuthenticatedClient(server);
    const repoName = path.basename(rootPath);
    const { data: repo } = await supabase
      .from("repos")
      .select("id")
      .eq("user_id", userId)
      .eq("name", repoName)
      .single();

    if (!repo) return undefined;

    const log = onProgress ?? ((step: string) => console.log(`  ${step}`));
    return async (hashes: string[]) => {
      try {
        await pullFromSupabase(
          rootPath, supabase, userId, repo.id, hashes, log
        );
      } catch {
        // Pull is a non-critical optimization -- silently degrade
      }
    };
  } catch {
    return undefined;
  }
}

async function runAnalyze(rootPath: string) {
  console.log("🔮 Ophan analyzing...\n");

  const pullFn = await createPullFn(rootPath);

  const result = await analyzeRepository(rootPath, (current, total, file) => {
    if (process.stdout.isTTY) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    }
    process.stdout.write(`  [${current}/${total}] ${file}\n`);
  }, pullFn, (analyzed, total) => {
    if (process.stdout.isTTY) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    }
    process.stdout.write(`  Analyzing: ${analyzed}/${total} functions`);
  });

  console.log(
    `\n✅ Done! ${result.analyzed} analyzed, ${result.skipped} cached` +
    (result.pulled ? ` (${result.pulled} from cloud)` : "") +
    ` across ${result.files} files` +
    (result.skippedSize ? ` (${result.skippedSize} files skipped — too large)` : "")
  );
  console.log(`   Database: .ophan/index.db`);
}

program
  .command("analyze")
  .description("Analyze repository for security issues and documentation")
  .option("-p, --path <path>", "Path to repository", process.cwd())
  .action(async (options) => {
    await runAnalyze(path.resolve(options.path));
  });

program
  .command("gc")
  .description("Remove orphaned analysis entries (manual, safe for branch switching)")
  .option("-p, --path <path>", "Path to repository", process.cwd())
  .option("-d, --days <days>", "Grace period in days", "30")
  .option("-f, --force", "Run GC even when not on default branch")
  .action(async (options) => {
    const rootPath = path.resolve(options.path);
    const maxAgeDays = parseInt(options.days, 10);
    const dbPath = path.join(rootPath, ".ophan", "index.db");

    // Branch safety check -- GC on a feature branch can orphan
    // hashes that only exist on the default branch
    const currentBranch = getGitBranch(rootPath);
    if (currentBranch !== null) {
      const defaultBranch = getDefaultBranch(rootPath);
      if (currentBranch !== defaultBranch && !options.force) {
        console.error(
          `⚠️  You're on branch '${currentBranch}', not '${defaultBranch}'.\n` +
          `   Running GC on a feature branch can delete analysis for functions\n` +
          `   that only exist on '${defaultBranch}'. If synced, these deletions\n` +
          `   propagate to the cloud.\n\n` +
          `   Switch to '${defaultBranch}' first, or use --force to proceed.`
        );
        process.exit(1);
      }
      if (currentBranch !== defaultBranch && options.force) {
        console.warn(
          `⚠️  Running GC on branch '${currentBranch}' (default: '${defaultBranch}').\n` +
          `   Proceeding with --force.\n`
        );
      }
    }

    console.log("🧹 Refreshing file index...\n");

    await refreshFileIndex(rootPath, (current, total, file) => {
      if (process.stdout.isTTY) {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
      }
      process.stdout.write(`  [${current}/${total}] ${file}\n`);
    });

    console.log("\n\n🗑️  Cleaning orphaned entries...");

    const result = gcAnalysis(dbPath, maxAgeDays);
    console.log(
      `\n✅ Removed ${result.deleted} orphaned entries (grace period: ${maxAgeDays} days)`
    );
  });

// ========== AUTH ==========

program
  .command("login")
  .description("Sign in to your self-hosted Ophan server via browser")
  .option("-s, --server <url>", "Ophan server (webapp) URL; saved for later commands. Defaults to OPHAN_SERVER_URL or the saved server")
  .action(async (options) => {
    let server;
    try {
      server = await requireServerConfig({ server: options.server });
    } catch (err: any) {
      console.error(`\n❌ ${err.message}`);
      process.exit(1);
    }

    // Credentials belong to one server: switching servers means signing in again.
    const previous = readSavedServer();
    if (server.serverUrl && previous && previous.serverUrl !== server.serverUrl) {
      deleteCredentials();
    }
    if (server.serverUrl) saveServer(server);

    const existing = readCredentials();
    if (existing) {
      // Validate the stored session is still good
      try {
        await getAuthenticatedClient(server);
        console.log(`  Already logged in as ${existing.email}`);
        console.log(`  Run \`npx @ophan/cli logout\` first to switch accounts.`);
        return;
      } catch {
        // Session expired/invalid -- delete stale credentials and re-login
        console.log("  Previous session expired. Re-authenticating...");
        deleteCredentials();
      }
    }

    try {
      const creds = await login(server);
      console.log(`\n✅ Logged in to ${server.serverUrl} as ${creds.email}`);
    } catch (err: any) {
      console.error(`\n❌ Login failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("logout")
  .description("Sign out and remove stored credentials")
  .action(() => {
    deleteCredentials();
    console.log("✅ Logged out. Credentials removed.");
  });

// ========== SYNC ==========

program
  .command("sync")
  .description("Sync analysis with your Ophan server (pull + push)")
  .option("-p, --path <path>", "Path to repository", process.cwd())
  .action(async (options) => {
    const rootPath = path.resolve(options.path);
    const dbPath = path.join(rootPath, ".ophan", "index.db");

    try {
      const server = await requireServerConfig();
      const { supabase, userId } = await getAuthenticatedClient(server);

      console.log(`☁️  Syncing with ${server.serverUrl || server.supabaseUrl}...\n`);

      // Pull first: fetch missing analysis from cloud
      let pulled = 0;
      const repoName = path.basename(rootPath);
      const { data: repo } = await supabase
        .from("repos")
        .select("id")
        .eq("user_id", userId)
        .eq("name", repoName)
        .single();

      if (repo) {
        const missingHashes = findMissingHashes(dbPath);
        if (missingHashes.length > 0) {
          const pullResult = await pullFromSupabase(
            rootPath, supabase, userId, repo.id, missingHashes,
            (step) => console.log(`  ${step}`)
          );
          pulled = pullResult.pulled;
        } else {
          console.log("  No missing analyses to pull.");
        }
      }

      // Then push local analysis to cloud
      const result = await syncToSupabase(
        rootPath, supabase, userId,
        (step) => console.log(`  ${step}`)
      );

      const parts = [
        `${pulled} pulled`,
        `${result.pushed} pushed`,
        `${result.locations} file locations synced`,
      ];
      if (result.practices > 0) parts.push(`${result.practices} practices synced`);
      if (result.communities > 0) parts.push(`${result.communities} community memberships`);
      if (result.communityEdges > 0) parts.push(`${result.communityEdges} community edges`);
      if (result.summaries > 0) parts.push(`${result.summaries} summaries`);
      if (result.gcProcessed > 0) parts.push(`${result.gcProcessed} GC deletions applied`);
      console.log(`\n✅ Sync complete: ${parts.join(", ")}`);
    } catch (err: any) {
      console.error(`\n❌ Sync failed: ${err.message}`);
      process.exit(1);
    }
  });

// ========== WATCH ==========

program
  .command("watch")
  .description("Watch for file changes and auto-analyze")
  .option("-p, --path <path>", "Path to repository", process.cwd())
  .option("--json", "Output structured JSON events (for IDE integration)")
  .option("--sync", "Auto-sync to your Ophan server after each analysis batch")
  .action(async (options) => {
    const rootPath = path.resolve(options.path);

    // Watch is long-running (used by extension host) -- never crash on stray rejections.
    // Common cause: Supabase server unreachable during pull/sync operations.
    process.on("unhandledRejection", (reason: any) => {
      const msg = reason?.message ?? String(reason);
      if (options.json) {
        process.stdout.write(JSON.stringify({ event: "error", message: `Unhandled rejection: ${msg}` }) + "\n");
      } else {
        console.error(`  ❌ Unexpected error: ${msg}`);
      }
    });

    const pullProgress = options.json
      ? (step: string) => process.stdout.write(JSON.stringify({ event: "pull_progress", message: step }) + "\n")
      : undefined;
    const pullFn = await createPullFn(rootPath, pullProgress);

    let syncFn: (() => Promise<{ pushed: number; locations: number; gcProcessed: number; communities: number; summaries: number }>) | undefined;
    if (options.sync) {
      const creds = readCredentials();
      const server = await resolveServerConfig().catch(() => null);
      const warn = (message: string) => {
        if (options.json) {
          process.stdout.write(JSON.stringify({ event: "sync_warning", message }) + "\n");
        } else {
          console.warn(`  ⚠️  ${message}`);
        }
      };
      if (!server) {
        warn(`${new NoServerConfiguredError().message} Sync disabled.`);
      } else if (creds) {
        try {
          const { supabase, userId } = await getAuthenticatedClient(server);
          syncFn = () => syncToSupabase(rootPath, supabase, userId);
        } catch {
          if (options.json) {
            process.stdout.write(JSON.stringify({ event: "sync_warning", message: "Session expired — sync disabled. Run npx @ophan/cli login." }) + "\n");
          } else {
            console.warn("  ⚠️  Session expired — sync disabled. Run `npx @ophan/cli login` to re-authenticate.");
          }
        }
      } else if (options.json) {
        process.stdout.write(JSON.stringify({ event: "sync_warning", message: "Not logged in — sync disabled. Run npx @ophan/cli login." }) + "\n");
      } else {
        console.warn("  ⚠️  Not logged in — sync disabled. Run `npx @ophan/cli login` to enable cloud sync.");
      }
    }

    await startWatch({
      rootPath,
      pullFn,
      syncFn,
      json: options.json,
    });
  });

// ========== INIT ==========

program
  .command("init")
  .description("Initialize Ophan for this repository (fast, no network calls)")
  .option("-p, --path <path>", "Path to repository", process.cwd())
  .action(async (options) => {
    const rootPath = path.resolve(options.path);
    const dbPath = path.join(rootPath, ".ophan", "index.db");

    console.log("Initializing Ophan...\n");

    // Create .ophan dir + DB tables + gitignore
    fs.mkdirSync(path.join(rootPath, ".ophan"), { recursive: true });
    ensureGitignore(rootPath);
    initDb(dbPath).close();

    // Scan files and index all functions
    let fileCount = 0;
    await refreshFileIndex(rootPath, (current, total, file) => {
      fileCount = total;
      if (process.stdout.isTTY) {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
      }
      process.stdout.write(`  [${current}/${total}] ${file}\n`);
    });

    // Count indexed functions
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT COUNT(*) as count FROM file_functions").get() as { count: number };
    db.close();

    console.log(`\n✅ Initialized! Found ${row.count} functions across ${fileCount} files.`);
    console.log(`   Database: .ophan/index.db\n`);
    console.log(`   Next: run \`npx @ophan/cli watch\` to start analysis.`);
  });

// ========== GRAPH ==========

program
  .command("graph")
  .description("Build function relationship graph and detect communities")
  .option("-p, --path <path>", "Path to repository", process.cwd())
  .option("-a, --algorithm <algorithm>", "Community detection algorithm (louvain, leiden, label-propagation)", DEFAULT_GRAPH_CONFIG.algorithm)
  .option("-r, --resolution <number>", "Louvain resolution parameter (higher = more communities)", String(DEFAULT_GRAPH_CONFIG.resolution))
  .option("--min-size <number>", "Minimum community size (smaller clusters are dissolved)", String(DEFAULT_GRAPH_CONFIG.minCommunitySize))
  .option("--max-size <number>", "Maximum community size (informational)", String(DEFAULT_GRAPH_CONFIG.maxCommunitySize))
  .option("--json", "Output results as JSON")
  .option("--summarize", "Generate documentation for detected communities using Claude")
  .option("--raw-source", "Use raw function source code for documentation (requires --summarize)")
  .option("--directory-decay <number>", "Directory distance decay factor (0=off, higher=stronger)", String(DEFAULT_GRAPH_CONFIG.directoryDecay))
  .option("--compare", "Compare multiple algorithm configurations side by side")
  .action(async (options) => {
    const rootPath = path.resolve(options.path);
    const dbPath = path.join(rootPath, ".ophan", "index.db");

    if (!fs.existsSync(dbPath)) {
      console.error("No .ophan/index.db found. Run `npx @ophan/cli init` first.");
      process.exit(1);
    }

    if (options.rawSource && !options.summarize) {
      console.error("--raw-source requires --summarize");
      process.exit(1);
    }

    const config: GraphConfig = {
      algorithm: options.algorithm as GraphConfig["algorithm"],
      edgeWeights: DEFAULT_GRAPH_CONFIG.edgeWeights,
      resolution: parseFloat(options.resolution),
      minCommunitySize: parseInt(options.minSize, 10),
      maxCommunitySize: parseInt(options.maxSize, 10),
      directoryDecay: parseFloat(options.directoryDecay),
    };

    if (!options.json) {
      console.log(`\nBuilding function graph (${config.algorithm}, resolution=${config.resolution})...\n`);
    }

    // Extract functions with relationship data
    const functions = await extractAllFunctions(rootPath, !options.json ? (current, total, file) => {
      if (process.stdout.isTTY) {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
      }
      process.stdout.write(`  [${current}/${total}] ${file}`);
    } : undefined);

    if (!options.json) {
      console.log(`\n\n  ${functions.length} functions extracted, resolving edges...\n`);
    }

    // Populate file_functions index from extracted functions (needed for edge resolution)
    const db = initDb(dbPath);

    // Snapshot old hashes before populateFileIndex overwrites file_functions
    // This enables incremental edge resolution (only recompute changed + neighbor edges)
    const oldHashes = new Set(
      db.prepare("SELECT DISTINCT content_hash FROM file_functions").all()
        .map((r: any) => r.content_hash as string)
    );
    populateFileIndex(db, functions);

    if (!options.json) {
      console.log(`  Indexed ${functions.length} functions, detecting communities...\n`);
    }

    // --compare mode: resolve edges once, run multiple algorithm configs, print table
    if (options.compare) {
      const resolver = rootPath ? buildModuleResolver(rootPath, functions) : undefined;
      const edges = resolveEdges(db, functions, config, undefined, resolver);
      storeEdges(db, edges);
      const edgesWithTransitive = addTransitiveEdges(edges, config);

      // Build hash→filePath map for directory distance decay
      let hashToFilePath: Map<string, string> | undefined;
      if (rootPath && (config.directoryDecay ?? 0) > 0) {
        hashToFilePath = new Map();
        for (const fn of functions) hashToFilePath.set(fn.contentHash, fn.filePath);
      }
      const allHashes = new Set(functions.map((f) => f.contentHash));

      const metrics = runComparison(edgesWithTransitive, config, DEFAULT_COMPARISONS, hashToFilePath, rootPath, allHashes);

      if (options.json) {
        console.log(JSON.stringify({ nodes: allHashes.size, edges: edgesWithTransitive.length, comparisons: metrics }));
      } else {
        console.log(`  Algorithm Comparison (${allHashes.size} nodes, ${edgesWithTransitive.length} edges)\n`);

        // Table header
        const header = [
          "Configuration".padEnd(25),
          "Communities".padStart(12),
          "Dissolved".padStart(14),
          "Coverage".padStart(9),
          "Min".padStart(5),
          "Med".padStart(5),
          "Max".padStart(5),
          "Modularity".padStart(11),
        ].join("");
        console.log(`  ${header}`);
        console.log(`  ${"─".repeat(header.length)}`);

        for (const m of metrics) {
          const dissolved = `${m.dissolvedCount} (${m.dissolvedPct.toFixed(0)}%)`;
          const modularity = m.modularity !== null ? m.modularity.toFixed(4) : "---";
          const row = [
            m.label.padEnd(25),
            String(m.communityCount).padStart(12),
            dissolved.padStart(14),
            `${m.coverage.toFixed(0)}%`.padStart(9),
            String(m.minSize).padStart(5),
            String(m.medianSize).padStart(5),
            String(m.maxSize).padStart(5),
            modularity.padStart(11),
          ].join("");
          console.log(`  ${row}`);
        }

        console.log();
      }

      db.close();
      return;
    }

    // Step 1: Build the graph (resolve edges, transitive edges)
    const edges = buildFunctionGraph(db, functions, config, oldHashes, rootPath);

    // Step 2: Detect communities on the graph
    const hierResult = detectHierarchicalCommunities(db, edges, functions, config, rootPath);
    const result = hierResult.l0;

    // Build source map for raw-source summarization mode
    let sourceMap: Map<string, string> | undefined;
    if (options.rawSource) {
      sourceMap = new Map();
      for (const fn of functions) sourceMap.set(fn.contentHash, fn.sourceCode);
    }

    if (options.json) {
      const output: Record<string, unknown> = {
        algorithm: config.algorithm,
        resolution: config.resolution,
        nodes: result.nodesInGraph,
        edges: result.edgesInGraph,
        communities: result.communityCount,
        dissolved: result.dissolvedCount,
        modularity: result.modularity,
        assignments: result.assignments,
        communityEdges: hierResult.communityEdges,
        l1Groups: hierResult.l1GroupCount,
        l1Assignments: hierResult.l1Assignments,
      };

      // Summarize if requested
      if (options.summarize) {
        const sumResult = await summarizeCommunities(db, {
          config: { algorithm: config.algorithm },
          sourceMap,
          rootPath,
        });
        const l1 = loadAllSummaries(db, config.algorithm, 1);
        const l2 = loadAllSummaries(db, config.algorithm, 2);
        const l3 = loadAllSummaries(db, config.algorithm, 3);
        const cc = loadAllSummaries(db, config.algorithm, 10);
        output.summaries = {
          l1: l1.map((s) => ({ communityId: s.communityId, ...s.summary as object })),
          l2: l2.map((s) => ({ communityId: s.communityId, ...s.summary as object })),
          l3: l3.map((s) => ({ communityId: s.communityId, ...s.summary as object })),
          crossCutting: cc.map((s) => ({ communityId: s.communityId, ...s.summary as object })),
          stats: sumResult,
        };
      }

      console.log(JSON.stringify(output));
    } else {
      // Edge type breakdown
      const edgeTypeCounts = new Map<string, number>();
      for (const e of edges) {
        edgeTypeCounts.set(e.edgeType, (edgeTypeCounts.get(e.edgeType) || 0) + 1);
      }
      const breakdown = ["call", "import", "co_location", "jsx_ref", "transitive_call", "co_caller"]
        .filter((t) => edgeTypeCounts.has(t))
        .map((t) => `${edgeTypeCounts.get(t)} ${t}`)
        .join(", ");

      console.log(`  Nodes:       ${result.nodesInGraph}`);
      console.log(`  Edges:       ${result.edgesInGraph} merged from ${edges.length} raw`);
      console.log(`               ${breakdown}`);
      console.log(`  Communities: ${result.communityCount}`);
      if (result.dissolvedCount > 0) {
        console.log(`  Dissolved:   ${result.dissolvedCount} (below min size ${config.minCommunitySize})`);
      }
      if (result.modularity !== null) {
        console.log(`  Modularity:  ${result.modularity.toFixed(4)}`);
      }
      if (result.effectiveResolution && result.effectiveResolution !== config.resolution) {
        console.log(`  Resolution:  ${result.effectiveResolution} (auto-scaled from ${config.resolution})`);
      }
      if (hierResult.l1GroupCount > 0) {
        console.log(`  Groups:      ${hierResult.l1GroupCount} (hierarchical)`);
      }
      if (hierResult.communityEdges.length > 0) {
        console.log(`  Cross-edges: ${hierResult.communityEdges.length} (between communities)`);
      }

      // Show community breakdown
      if (result.communityCount > 0) {
        const communityMap = new Map<string, string[]>();
        for (const a of result.assignments) {
          if (a.communityId === "__dissolved") continue;
          const members = communityMap.get(a.communityId) || [];
          members.push(a.contentHash);
          communityMap.set(a.communityId, members);
        }

        console.log(`\n  Community breakdown:`);

        // Look up function names from DB for display
        const readDb = new Database(dbPath, { readonly: true });
        const lookupName = readDb.prepare(
          "SELECT function_name, file_path FROM file_functions WHERE content_hash = ? LIMIT 1"
        );

        const sorted = [...communityMap.entries()].sort((a, b) => b[1].length - a[1].length);
        for (const [communityId, hashes] of sorted) {
          const overMax = hashes.length > config.maxCommunitySize;
          const flag = overMax ? " (large)" : "";
          console.log(`\n    Community ${communityId}${flag} (${hashes.length} functions):`);
          for (const hash of hashes.slice(0, 15)) {
            const row = lookupName.get(hash) as { function_name: string; file_path: string } | undefined;
            if (row) {
              const relPath = path.relative(rootPath, row.file_path);
              console.log(`      ${row.function_name}  (${relPath})`);
            } else {
              console.log(`      ${hash.slice(0, 12)}...`);
            }
          }
          if (hashes.length > 15) {
            console.log(`      ... and ${hashes.length - 15} more`);
          }
        }

        readDb.close();
      }

      // Summarize if requested
      if (options.summarize) {
        // Check if any function analysis exists (for a useful warning in non-raw mode)
        const analysisCount = (db.prepare("SELECT COUNT(*) as count FROM function_analysis").get() as { count: number }).count;
        if (!options.rawSource && analysisCount === 0) {
          console.log("  ⚠️  No function analysis found. Run `ophan analyze` first for best results.\n");
        } else if (result.communityCount > 0) {
          console.log(options.rawSource
            ? "\n📝 Generating documentation from source code...\n"
            : "\n📝 Generating documentation...\n"
          );

          const sumResult = await summarizeCommunities(db, {
            config: { algorithm: config.algorithm },
            onProgress: (step) => console.log(`  ${step}`),
            sourceMap,
            rootPath,
          });

          const generated = sumResult.l1Summarized + sumResult.l2Summarized + sumResult.l3Summarized;
          const cached = sumResult.l1Cached + sumResult.l2Cached + sumResult.l3Cached;
          const driftSkipped = sumResult.l1DriftSkipped;
          const failed = sumResult.l1Failed ?? 0;
          const parts = [`${generated} generated`, `${cached} cached`];
          if (driftSkipped > 0) parts.push(`${driftSkipped} drift-skipped`);
          if (failed > 0) parts.push(`${failed} failed`);
          console.log(`\n✅ Documentation: ${parts.join(", ")}`);

          if (sumResult.ccDetected > 0) {
            console.log(`  Cross-cutting: ${sumResult.ccDetected} detected, ${sumResult.ccSummarized} documented, ${sumResult.ccCached} cached`);

            const ccSummaries = loadAllSummaries(db, config.algorithm, 10);
            if (ccSummaries.length > 0) {
              console.log(`\n  Cross-Cutting Concerns:`);
              for (const s of ccSummaries) {
                const sum = s.summary as Record<string, unknown>;
                const badge = sum.concernType === "security" ? "SEC" : "DATA";
                const communities = (sum.affectedCommunities as { communityTitle: string }[] || [])
                  .map((c) => c.communityTitle).join(", ");
                console.log(`    [${badge}] ${sum.title} (${communities})`);
              }
            }
          }
        }
      }

      console.log();
    }

    db.close();
  });

program.parse();
