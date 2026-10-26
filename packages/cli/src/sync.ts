import Database from "better-sqlite3";
import { SupabaseClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import pLimit from "p-limit";
import { importAnalysis, importPractices } from "@ophan/core";

interface AnalysisRow {
  content_hash: string;
  analysis_type: string;
  analysis: string;
  model_version: string;
  schema_version: number;
  language: string;
  entity_type: string;
  created_at: number;
}

interface FileLocationRow {
  file_path: string;
  function_name: string;
  content_hash: string;
  language: string;
  entity_type: string;
  start_line: number;
}

interface GcRow {
  content_hash: string;
  analysis_type: string | null;
}

interface CommunityRow {
  content_hash: string;
  level: number;
  community_id: string;
  algorithm: string;
}

interface CommunityEdgeRow {
  source_community: string;
  target_community: string;
  algorithm: string;
  weight: number;
  edge_count: number;
}

interface CommunitySummaryRow {
  community_id: string;
  level: number;
  algorithm: string;
  input_hash: string;
  summary: string;
  model_version: string | null;
  created_at: number;
}

const supabaseLimit = pLimit(3);

/** Run chunked Supabase operations in parallel with bounded concurrency. */
async function parallelChunks<T>(
  rows: T[],
  chunkSize: number,
  fn: (chunk: T[]) => Promise<void>
): Promise<void> {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    chunks.push(rows.slice(i, i + chunkSize));
  }
  await Promise.all(chunks.map((chunk) => supabaseLimit(() => fn(chunk))));
}

export function getGitBranch(rootPath: string): string | null {
  try {
    return (
      execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: rootPath,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

export function getGitCommitHash(rootPath: string): string | null {
  try {
    return (
      execSync("git rev-parse HEAD", {
        cwd: rootPath,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

export function getDefaultBranch(rootPath: string): string {
  try {
    const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
      cwd: rootPath,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // ref = "refs/remotes/origin/main" → extract "main"
    const match = ref.match(/refs\/remotes\/origin\/(.+)/);
    if (match) return match[1];
  } catch {
    // No remote, shallow clone, or not a git repo
  }
  return "main";
}

function getGitRemoteUrl(rootPath: string): string | null {
  try {
    return (
      execSync("git remote get-url origin", {
        cwd: rootPath,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

export async function syncToSupabase(
  rootPath: string,
  supabase: SupabaseClient,
  userId: string,
  onProgress?: (step: string) => void
): Promise<{ pushed: number; locations: number; gcProcessed: number; practices: number; communities: number; communityEdges: number; summaries: number; skippedArchitecture: boolean; commitHash: string | null }> {
  const dbPath = path.join(rootPath, ".ophan", "index.db");
  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `No analysis database found at ${dbPath}\n  Run \`npx @ophan/cli init\` first.`
    );
  }

  const db = new Database(dbPath);

  // Ensure sync_meta table exists (may not if DB was created by older version)
  db.exec(
    "CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
  );

  try {
    // 0. Detect user change -- if different user, reset sync state
    const lastUser = db
      .prepare("SELECT value FROM sync_meta WHERE key = 'last_synced_user_id'")
      .get() as { value: string } | undefined;

    if (lastUser && lastUser.value !== userId) {
      onProgress?.(
        `Account changed (was ${lastUser.value.slice(0, 8)}...). Re-syncing all data...`
      );
      db.exec("UPDATE function_analysis SET synced_at = NULL");
      db.exec("DELETE FROM function_gc");
    }

    // Update last synced user
    db.prepare(
      "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_synced_user_id', ?)"
    ).run(userId);

    // 1. Ensure repo exists
    const repoName = path.basename(rootPath);
    const remoteUrl = getGitRemoteUrl(rootPath);

    onProgress?.("Registering repo...");

    const { data: repo, error: repoError } = await supabase
      .from("repos")
      .upsert(
        {
          user_id: userId,
          name: repoName,
          remote_url: remoteUrl,
        },
        { onConflict: "user_id,name" }
      )
      .select("id, docs_branch")
      .single();

    if (repoError) {
      throw new Error(`Failed to register repo: ${repoError.message}`);
    }
    const repoId = repo.id;
    const docsBranch: string = repo.docs_branch ?? "main";

    // Determine whether to sync architecture data (communities, edges, summaries).
    // Gate: only sync when on the configured docs branch.
    // Non-git repos (branch = null) bypass the gate -- always sync.
    const currentBranch = getGitBranch(rootPath);
    const syncArchitecture = currentBranch === null || currentBranch === docsBranch;

    if (!syncArchitecture) {
      onProgress?.(`Skipping architecture sync (on '${currentBranch}', docs branch is '${docsBranch}')`);
    }

    // 1.5. Pull practices from Supabase → local SQLite
    onProgress?.("Syncing practices...");
    const { data: practiceRows } = await supabase
      .from("repo_practices")
      .select("practice_id, rule, severity")
      .eq("repo_id", repoId);

    const practicesSynced = practiceRows?.length ?? 0;
    if (practiceRows && practiceRows.length > 0) {
      importPractices(db, practiceRows.map((r) => ({
        id: r.practice_id,
        rule: r.rule,
        severity: r.severity as "error" | "warning" | "info",
      })));
    } else {
      // No practices defined -- clear local table
      try { db.prepare("DELETE FROM practices").run(); } catch {}
    }

    // 2. Push unsynced analysis (now includes analysis_type + schema_version)
    onProgress?.("Pushing analysis...");

    const unsynced = db
      .prepare(
        `SELECT content_hash, analysis_type, analysis, model_version, schema_version, language, entity_type, created_at
         FROM function_analysis WHERE synced_at IS NULL`
      )
      .all() as AnalysisRow[];

    if (unsynced.length > 0) {
      const rows = unsynced.map((row) => ({
        content_hash: row.content_hash,
        analysis_type: row.analysis_type,
        repo_id: repoId,
        user_id: userId,
        analysis: JSON.parse(row.analysis),
        model_version: row.model_version,
        schema_version: row.schema_version,
        language: row.language,
        entity_type: row.entity_type,
      }));

      // Batch upsert in chunks of 500 with bounded concurrency
      await parallelChunks(rows, 500, async (chunk) => {
        const { error } = await supabase
          .from("function_analysis")
          .upsert(chunk, { onConflict: "content_hash,repo_id,analysis_type" });
        if (error) {
          throw new Error(`Failed to push analysis: ${error.message}`);
        }
      });

      // Mark as synced locally
      const now = Math.floor(Date.now() / 1000);
      const markSynced = db.prepare(
        "UPDATE function_analysis SET synced_at = ? WHERE content_hash = ? AND analysis_type = ?"
      );
      const markBatch = db.transaction(() => {
        for (const row of unsynced) {
          markSynced.run(now, row.content_hash, row.analysis_type);
        }
      });
      markBatch();
    }

    // 3. Replace function_locations (full sync each time)
    onProgress?.("Syncing file locations...");

    const { error: delError } = await supabase
      .from("function_locations")
      .delete()
      .eq("repo_id", repoId);
    if (delError) {
      throw new Error(`Failed to clear locations: ${delError.message}`);
    }

    const locations = db
      .prepare(
        `SELECT file_path, function_name, content_hash, language, entity_type, start_line
         FROM file_functions
         GROUP BY file_path, function_name`
      )
      .all() as FileLocationRow[];

    if (locations.length > 0) {
      // Convert absolute paths to repo-relative for cloud storage
      // (local DB stores absolute paths for file I/O, but cloud paths
      // must be portable across machines)
      const rootPrefix = rootPath.endsWith(path.sep)
        ? rootPath
        : rootPath + path.sep;

      const locationRows = locations.map((row) => ({
        repo_id: repoId,
        user_id: userId,
        file_path: row.file_path.startsWith(rootPrefix)
          ? row.file_path.slice(rootPrefix.length)
          : row.file_path,
        function_name: row.function_name,
        content_hash: row.content_hash,
        language: row.language,
        entity_type: row.entity_type,
        start_line: row.start_line,
      }));

      await parallelChunks(locationRows, 500, async (chunk) => {
        const { error } = await supabase
          .from("function_locations")
          .insert(chunk);
        if (error) {
          throw new Error(`Failed to push locations: ${error.message}`);
        }
      });
    }

    // 4. Process GC tombstones
    onProgress?.("Processing garbage collection...");

    const gcRows = db
      .prepare("SELECT content_hash, analysis_type FROM function_gc WHERE synced_at IS NULL")
      .all() as GcRow[];

    if (gcRows.length > 0) {
      // Batch GC deletes using .in() for efficiency
      const withType = gcRows.filter((r) => r.analysis_type);
      const withoutType = gcRows.filter((r) => !r.analysis_type);

      // Delete analysis rows with specific type (group by type)
      if (withType.length > 0) {
        const byType = new Map<string, string[]>();
        for (const row of withType) {
          const hashes = byType.get(row.analysis_type!) || [];
          hashes.push(row.content_hash);
          byType.set(row.analysis_type!, hashes);
        }
        await Promise.all([...byType.entries()].map(([type, hashes]) =>
          parallelChunks(hashes, 50, async (chunk) => {
            await supabase.from("function_analysis").delete()
              .eq("repo_id", repoId).eq("analysis_type", type).in("content_hash", chunk);
          })
        ));
      }

      // Delete analysis rows without type (legacy GC entries)
      if (withoutType.length > 0) {
        const legacyHashes = withoutType.map((r) => r.content_hash);
        await parallelChunks(legacyHashes, 50, async (chunk) => {
          await supabase.from("function_analysis").delete()
            .eq("repo_id", repoId).in("content_hash", chunk);
        });
      }

      // Delete location rows for all GC'd hashes
      const allGcHashes = gcRows.map((r) => r.content_hash);
      await parallelChunks(allGcHashes, 50, async (chunk) => {
        await supabase.from("function_locations").delete()
          .eq("repo_id", repoId).in("content_hash", chunk);
      });

      // Mark GC rows as synced locally, then delete them
      const now = Math.floor(Date.now() / 1000);
      db.transaction(() => {
        db.prepare("UPDATE function_gc SET synced_at = ? WHERE synced_at IS NULL").run(now);
        db.prepare("DELETE FROM function_gc WHERE synced_at IS NOT NULL").run();
      })();
    }

    // 5. Replace communities (full sync, like function_locations)
    // Steps 5-7 are gated by syncArchitecture (only sync on docs branch)
    let communitiesSynced = 0;

    if (!syncArchitecture) {
      return {
        pushed: unsynced.length,
        locations: locations.length,
        gcProcessed: gcRows.length,
        practices: practicesSynced,
        communities: 0,
        communityEdges: 0,
        summaries: 0,
        skippedArchitecture: true,
        commitHash: null,
      };
    }

    const hasCommunities = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='communities'"
    ).get();

    if (hasCommunities) {
      onProgress?.("Syncing community memberships...");

      const { error: commDelError } = await supabase
        .from("communities")
        .delete()
        .eq("repo_id", repoId);
      if (commDelError) {
        throw new Error(`Failed to clear communities: ${commDelError.message}`);
      }

      const communityRows = db.prepare(
        "SELECT content_hash, level, community_id, algorithm FROM communities"
      ).all() as CommunityRow[];

      if (communityRows.length > 0) {
        const rows = communityRows.map((row) => ({
          content_hash: row.content_hash,
          level: row.level,
          community_id: row.community_id,
          algorithm: row.algorithm,
          repo_id: repoId,
          user_id: userId,
        }));

        await parallelChunks(rows, 500, async (chunk) => {
          const { error } = await supabase.from("communities").insert(chunk);
          if (error) {
            throw new Error(`Failed to push communities: ${error.message}`);
          }
        });
        communitiesSynced = communityRows.length;
      }
    }

    // 6. Replace community_edges (full sync, like communities)
    let communityEdgesSynced = 0;

    const hasCommunityEdges = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='community_edges'"
    ).get();

    if (hasCommunityEdges) {
      onProgress?.("Syncing community edges...");

      const { error: ceDelError } = await supabase
        .from("community_edges")
        .delete()
        .eq("repo_id", repoId);
      if (ceDelError) {
        throw new Error(`Failed to clear community edges: ${ceDelError.message}`);
      }

      const ceRows = db.prepare(
        "SELECT source_community, target_community, algorithm, weight, edge_count FROM community_edges"
      ).all() as CommunityEdgeRow[];

      if (ceRows.length > 0) {
        const rows = ceRows.map((row) => ({
          source_community: row.source_community,
          target_community: row.target_community,
          algorithm: row.algorithm,
          repo_id: repoId,
          user_id: userId,
          weight: row.weight,
          edge_count: row.edge_count,
        }));

        await parallelChunks(rows, 500, async (chunk) => {
          const { error } = await supabase.from("community_edges").insert(chunk);
          if (error) {
            throw new Error(`Failed to push community edges: ${error.message}`);
          }
        });
        communityEdgesSynced = ceRows.length;
      }
    }

    // 7. Replace community summaries (full sync, like communities)
    let summariesSynced = 0;

    const hasSummaries = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='community_summaries'"
    ).get();

    if (hasSummaries) {
      onProgress?.("Syncing community summaries...");

      const { error: sumDelError } = await supabase
        .from("community_summaries")
        .delete()
        .eq("repo_id", repoId);
      if (sumDelError) {
        throw new Error(`Failed to clear summaries: ${sumDelError.message}`);
      }

      const summaryRows = db.prepare(
        "SELECT community_id, level, algorithm, input_hash, summary, model_version, created_at FROM community_summaries"
      ).all() as CommunitySummaryRow[];

      if (summaryRows.length > 0) {
        const rows = summaryRows.map((row) => ({
          community_id: row.community_id,
          level: row.level,
          algorithm: row.algorithm,
          repo_id: repoId,
          user_id: userId,
          input_hash: row.input_hash,
          summary: JSON.parse(row.summary),
          model_version: row.model_version,
        }));

        await parallelChunks(rows, 500, async (chunk) => {
          const { error } = await supabase
            .from("community_summaries")
            .insert(chunk);
          if (error) {
            throw new Error(`Failed to push summaries: ${error.message}`);
          }
        });
        summariesSynced = summaryRows.length;
      }
    }

    // 8. Record docs sync commit hash (git repos only)
    const commitHash = getGitCommitHash(rootPath);
    if (commitHash && currentBranch) {
      await supabase.from("docs_sync_history").insert({
        repo_id: repoId,
        user_id: userId,
        commit_hash: commitHash,
        branch: currentBranch,
      });
      await supabase
        .from("repos")
        .update({
          last_docs_sync_commit: commitHash,
          last_docs_sync_at: new Date().toISOString(),
        })
        .eq("id", repoId);
    }

    return {
      pushed: unsynced.length,
      locations: locations.length,
      gcProcessed: gcRows.length,
      practices: practicesSynced,
      communities: communitiesSynced,
      communityEdges: communityEdgesSynced,
      summaries: summariesSynced,
      skippedArchitecture: false,
      commitHash,
    };
  } finally {
    db.close();
  }
}

// ============ PULL SYNC ============

/**
 * Pull analysis from Supabase for content hashes missing locally.
 * Used before `analyzeRepository()` to avoid re-running expensive Claude analysis.
 */
export async function pullFromSupabase(
  rootPath: string,
  supabase: SupabaseClient,
  userId: string,
  repoId: string,
  missingHashes: string[],
  onProgress?: (step: string) => void
): Promise<{ pulled: number }> {
  if (missingHashes.length === 0) return { pulled: 0 };

  const dbPath = path.join(rootPath, ".ophan", "index.db");
  onProgress?.(`Pulling ${missingHashes.length} cached analyses from cloud...`);

  const allRows: {
    content_hash: string;
    analysis_type: string;
    analysis: string;
    model_version: string;
    schema_version: number;
    language: string;
    entity_type: string;
  }[] = [];

  // Batch queries in chunks of 50 with bounded concurrency
  // (SHA256 hashes are 64 chars each; 50 × 64 ≈ 3.2KB fits within URI limits)
  const pullChunks: string[][] = [];
  for (let i = 0; i < missingHashes.length; i += 50) {
    pullChunks.push(missingHashes.slice(i, i + 50));
  }

  await Promise.all(pullChunks.map((chunk) => supabaseLimit(async () => {
    try {
      const { data, error } = await supabase
        .from("function_analysis")
        .select("content_hash, analysis_type, analysis, model_version, schema_version, language, entity_type")
        .eq("repo_id", repoId)
        .in("content_hash", chunk);

      if (error) {
        onProgress?.(`Warning: pull failed: ${error.message}`);
        return;
      }

      if (data) {
        for (const row of data) {
          allRows.push({
            content_hash: row.content_hash,
            analysis_type: row.analysis_type,
            analysis: typeof row.analysis === "string" ? row.analysis : JSON.stringify(row.analysis),
            model_version: row.model_version,
            schema_version: row.schema_version ?? 1,
            language: row.language ?? "typescript",
            entity_type: row.entity_type ?? "function",
          });
        }
      }
    } catch (err: any) {
      onProgress?.(`Warning: pull request failed: ${err?.message ?? String(err)}`);
    }
  })));

  if (allRows.length === 0) return { pulled: 0 };

  const imported = importAnalysis(dbPath, allRows);
  onProgress?.(`Pulled ${imported} analyses from cloud`);
  return { pulled: imported };
}
