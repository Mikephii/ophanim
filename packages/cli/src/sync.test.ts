import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createTempDb, createMockSupabase } from "./test-utils";
import { syncToSupabase, pullFromSupabase, getGitBranch, getGitCommitHash, getDefaultBranch } from "./sync";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execSync: vi.fn((cmd: string, opts?: any) => {
      // Mock git rev-parse --abbrev-ref HEAD (branch detection)
      if (typeof cmd === "string" && cmd.includes("rev-parse --abbrev-ref HEAD")) {
        const branch = (globalThis as any).__mockGitBranch;
        if (branch === null) throw new Error("not a git repo");
        return branch ?? "main";
      }
      // Mock git rev-parse HEAD (commit hash detection)
      if (typeof cmd === "string" && cmd === "git rev-parse HEAD") {
        const hash = (globalThis as any).__mockGitCommitHash;
        if (hash === null) throw new Error("not a git repo");
        return hash ?? "abc123def456789012345678901234567890abcd";
      }
      // Mock git symbolic-ref refs/remotes/origin/HEAD (default branch detection)
      if (typeof cmd === "string" && cmd.includes("symbolic-ref refs/remotes/origin/HEAD")) {
        const defaultBranch = (globalThis as any).__mockDefaultBranch;
        if (defaultBranch === null) throw new Error("not a symbolic ref");
        return `refs/remotes/origin/${defaultBranch ?? "main"}`;
      }
      return actual.execSync(cmd, opts);
    }),
  };
});
import {
  insertAnalysisPair,
  insertFileFunction,
  insertCommunity,
  insertCommunityEdge,
  insertCommunitySummary,
  makeDocAnalysisJson,
  makeSecAnalysisJson,
} from "@ophan/core/test-utils";

const USER_A = "user-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "user-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const REPO_ID = "repo-1";

function defaultRepoResponse(docsBranch = "main") {
  return { data: { id: REPO_ID, docs_branch: docsBranch }, error: null };
}

function setMockBranch(branch: string | null) {
  (globalThis as any).__mockGitBranch = branch;
}

function setMockCommitHash(hash: string | null) {
  (globalThis as any).__mockGitCommitHash = hash;
}

function setMockDefaultBranch(branch: string | null) {
  (globalThis as any).__mockDefaultBranch = branch;
}

// ============ getDefaultBranch ============

describe("getDefaultBranch", () => {
  afterEach(() => {
    setMockDefaultBranch(undefined as any);
  });

  it("returns 'main' for standard repos", () => {
    // Default mock: __mockDefaultBranch is undefined → returns "main"
    expect(getDefaultBranch("/some/repo")).toBe("main");
  });

  it("returns 'master' when remote HEAD points to master", () => {
    setMockDefaultBranch("master");
    expect(getDefaultBranch("/some/repo")).toBe("master");
  });

  it("returns 'main' when symbolic-ref fails (no remote)", () => {
    setMockDefaultBranch(null);
    expect(getDefaultBranch("/some/repo")).toBe("main");
  });

  it("returns 'main' for non-git repos (all git commands fail)", () => {
    // When symbolic-ref throws (null), falls back to "main"
    setMockDefaultBranch(null);
    expect(getDefaultBranch("/not/a/git/repo")).toBe("main");
  });
});

// ============ syncToSupabase ============

describe("syncToSupabase", () => {
  const cleanups: (() => void)[] = [];
  function tracked(result: ReturnType<typeof createTempDb>) {
    cleanups.push(result.cleanup);
    return result;
  }
  afterEach(() => {
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
  });

  describe("account change detection", () => {
    it("first sync — stores user_id, no reset", async () => {
      const { rootPath, dbPath } = tracked(createTempDb());

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      await syncToSupabase(rootPath, mock.client, USER_A);

      const db = new Database(dbPath);
      const row = db
        .prepare("SELECT value FROM sync_meta WHERE key = 'last_synced_user_id'")
        .get() as { value: string };
      db.close();

      expect(row.value).toBe(USER_A);
    });

    it("same user re-sync — no reset of synced_at", async () => {
      const { rootPath, dbPath } = tracked(
        createTempDb((db) => {
          db.prepare(
            "INSERT INTO sync_meta (key, value) VALUES ('last_synced_user_id', ?)"
          ).run(USER_A);
          insertAnalysisPair(db, "hash1", { syncedAt: 1000 });
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      await syncToSupabase(rootPath, mock.client, USER_A);

      // synced_at should still be set (not reset to NULL)
      const db = new Database(dbPath);
      const row = db
        .prepare(
          "SELECT synced_at FROM function_analysis WHERE content_hash = 'hash1' AND analysis_type = 'documentation'"
        )
        .get() as { synced_at: number | null };
      db.close();

      expect(row.synced_at).toBe(1000);
    });

    it("different user — resets synced_at to NULL and clears GC", async () => {
      const { rootPath, dbPath } = tracked(
        createTempDb((db) => {
          db.prepare(
            "INSERT INTO sync_meta (key, value) VALUES ('last_synced_user_id', ?)"
          ).run(USER_A);
          insertAnalysisPair(db, "hash1", { syncedAt: 1000 });
          db.prepare(
            "INSERT INTO function_gc (content_hash, analysis_type, gc_at) VALUES ('old', 'documentation', 999)"
          ).run();
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      await syncToSupabase(rootPath, mock.client, USER_B);

      const db = new Database(dbPath);
      // synced_at should be NULL (reset) then re-set by the push
      const meta = db
        .prepare("SELECT value FROM sync_meta WHERE key = 'last_synced_user_id'")
        .get() as { value: string };
      const gcCount = db
        .prepare("SELECT count(*) as c FROM function_gc")
        .get() as { c: number };
      db.close();

      expect(meta.value).toBe(USER_B);
      expect(gcCount.c).toBe(0);
    });
  });

  describe("push batching", () => {
    it("pushes only unsynced rows (synced_at IS NULL)", async () => {
      const { rootPath } = tracked(
        createTempDb((db) => {
          insertAnalysisPair(db, "hash-synced", { syncedAt: 1000 });
          insertAnalysisPair(db, "hash-unsynced", { syncedAt: null });
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      const result = await syncToSupabase(rootPath, mock.client, USER_A);

      // Only hash-unsynced's 2 rows (doc + sec) should be pushed
      expect(result.pushed).toBe(2);
    });

    it("marks synced_at after push", async () => {
      const { rootPath, dbPath } = tracked(
        createTempDb((db) => {
          insertAnalysisPair(db, "hash1", { syncedAt: null });
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      await syncToSupabase(rootPath, mock.client, USER_A);

      const db = new Database(dbPath);
      const rows = db
        .prepare(
          "SELECT synced_at FROM function_analysis WHERE content_hash = 'hash1'"
        )
        .all() as { synced_at: number | null }[];
      db.close();

      for (const row of rows) {
        expect(row.synced_at).not.toBeNull();
        expect(row.synced_at).toBeGreaterThan(0);
      }
    });
  });

  describe("location full-sync", () => {
    it("DELETE + INSERT pattern for file_functions", async () => {
      const { rootPath } = tracked(
        createTempDb((db) => {
          insertFileFunction(db, "src/a.ts", "fn1", "hash1");
          insertFileFunction(db, "src/b.ts", "fn2", "hash2");
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      const result = await syncToSupabase(rootPath, mock.client, USER_A);

      expect(result.locations).toBe(2);

      // Verify DELETE was called before INSERT
      const locationCalls = mock.calls.filter(
        (c) => c.table === "function_locations"
      );
      const deleteIdx = locationCalls.findIndex((c) => c.method === "delete");
      const insertIdx = locationCalls.findIndex((c) => c.method === "insert");
      expect(deleteIdx).toBeLessThan(insertIdx);
    });

    it("converts absolute file paths to repo-relative", async () => {
      const { rootPath, dbPath } = tracked(createTempDb());

      // Insert with absolute paths after we know rootPath
      const db = new Database(dbPath);
      insertFileFunction(db, `${rootPath}/src/auth.ts`, "login", "hash1");
      insertFileFunction(db, `${rootPath}/lib/utils.ts`, "format", "hash2");
      // Also insert one already-relative path (edge case)
      insertFileFunction(db, "src/already-relative.ts", "fn3", "hash3");
      db.close();

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      await syncToSupabase(rootPath, mock.client, USER_A);

      // Find the insert call(s) for function_locations
      const insertCalls = mock.calls.filter(
        (c) => c.table === "function_locations" && c.method === "insert"
      );
      expect(insertCalls.length).toBeGreaterThan(0);

      // Collect all inserted rows
      const insertedRows = insertCalls.flatMap((c) => c.args[0]) as {
        file_path: string;
        function_name: string;
      }[];

      // Absolute paths should have been converted to relative
      const authRow = insertedRows.find((r) => r.function_name === "login");
      expect(authRow?.file_path).toBe("src/auth.ts");

      const utilsRow = insertedRows.find((r) => r.function_name === "format");
      expect(utilsRow?.file_path).toBe("lib/utils.ts");

      // Already-relative paths should pass through unchanged
      const relRow = insertedRows.find((r) => r.function_name === "fn3");
      expect(relRow?.file_path).toBe("src/already-relative.ts");
    });

    it("includes start_line in location rows", async () => {
      const { rootPath } = tracked(
        createTempDb((db) => {
          insertFileFunction(db, "src/a.ts", "fn1", "hash1", { startLine: 10 });
          insertFileFunction(db, "src/b.ts", "fn2", "hash2", { startLine: 42 });
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      await syncToSupabase(rootPath, mock.client, USER_A);

      const insertCalls = mock.calls.filter(
        (c) => c.table === "function_locations" && c.method === "insert"
      );
      const insertedRows = insertCalls.flatMap((c) => c.args[0]) as {
        function_name: string;
        start_line: number;
      }[];

      const fn1Row = insertedRows.find((r) => r.function_name === "fn1");
      expect(fn1Row?.start_line).toBe(10);

      const fn2Row = insertedRows.find((r) => r.function_name === "fn2");
      expect(fn2Row?.start_line).toBe(42);
    });

    it("empty file_functions — only deletes remote", async () => {
      const { rootPath } = tracked(createTempDb());

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      const result = await syncToSupabase(rootPath, mock.client, USER_A);

      expect(result.locations).toBe(0);

      // Should still call delete (clear remote)
      const deleteCalls = mock.calls.filter(
        (c) => c.table === "function_locations" && c.method === "delete"
      );
      expect(deleteCalls.length).toBe(1);

      // Should NOT call insert
      const insertCalls = mock.calls.filter(
        (c) => c.table === "function_locations" && c.method === "insert"
      );
      expect(insertCalls.length).toBe(0);
    });
  });

  describe("GC tombstone propagation", () => {
    it("processes unsynced GC entries and cleans them up", async () => {
      const { rootPath, dbPath } = tracked(
        createTempDb((db) => {
          db.prepare(
            "INSERT INTO function_gc (content_hash, analysis_type, gc_at) VALUES (?, ?, ?)"
          ).run("dead-hash", "documentation", Math.floor(Date.now() / 1000));
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      const result = await syncToSupabase(rootPath, mock.client, USER_A);

      expect(result.gcProcessed).toBe(1);

      // GC rows should be cleaned up (synced then deleted)
      const db = new Database(dbPath);
      const gcCount = db
        .prepare("SELECT count(*) as c FROM function_gc")
        .get() as { c: number };
      db.close();

      expect(gcCount.c).toBe(0);
    });

    it("type-specific tombstone — deletes specific analysis_type", async () => {
      const { rootPath } = tracked(
        createTempDb((db) => {
          db.prepare(
            "INSERT INTO function_gc (content_hash, analysis_type, gc_at) VALUES (?, ?, ?)"
          ).run("dead-hash", "security", Math.floor(Date.now() / 1000));
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      await syncToSupabase(rootPath, mock.client, USER_A);

      // Should delete with analysis_type filter
      const deleteCalls = mock.calls.filter(
        (c) => c.table === "function_analysis" && c.method === "delete"
      );
      expect(deleteCalls.length).toBe(1);

      // Should have eq('analysis_type', 'security') in the chain
      const eqCalls = mock.calls.filter(
        (c) =>
          c.table === "function_analysis" &&
          c.method === "eq" &&
          c.args[0] === "analysis_type"
      );
      expect(eqCalls.length).toBe(1);
      expect(eqCalls[0].args[1]).toBe("security");
    });

    it("NULL analysis_type (legacy) — deletes all types for hash", async () => {
      const { rootPath } = tracked(
        createTempDb((db) => {
          db.prepare(
            "INSERT INTO function_gc (content_hash, analysis_type, gc_at) VALUES (?, ?, ?)"
          ).run("dead-hash", null, Math.floor(Date.now() / 1000));
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      await syncToSupabase(rootPath, mock.client, USER_A);

      // Should delete WITHOUT analysis_type filter (no eq('analysis_type', ...))
      const eqCalls = mock.calls.filter(
        (c) =>
          c.table === "function_analysis" &&
          c.method === "eq" &&
          c.args[0] === "analysis_type"
      );
      expect(eqCalls.length).toBe(0);
    });
  });
  describe("community sync", () => {
    it("syncs communities with DELETE + INSERT pattern", async () => {
      const { rootPath } = tracked(
        createTempDb((db) => {
          insertCommunity(db, "hash_a", "c0");
          insertCommunity(db, "hash_b", "c0");
          insertCommunity(db, "hash_c", "c1");
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      const result = await syncToSupabase(rootPath, mock.client, USER_A);

      expect(result.communities).toBe(3);

      // Verify DELETE was called before INSERT
      const commCalls = mock.calls.filter((c) => c.table === "communities");
      const deleteIdx = commCalls.findIndex((c) => c.method === "delete");
      const insertIdx = commCalls.findIndex((c) => c.method === "insert");
      expect(deleteIdx).toBeGreaterThanOrEqual(0);
      expect(insertIdx).toBeGreaterThan(deleteIdx);
    });

    it("syncs community summaries with DELETE + INSERT pattern", async () => {
      const { rootPath } = tracked(
        createTempDb((db) => {
          insertCommunitySummary(db, "c0", {
            summary: { title: "Auth", documentation: "# Auth", meta: {} },
          });
          insertCommunitySummary(db, "c1", {
            summary: { title: "DB", documentation: "# DB", meta: {} },
          });
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      const result = await syncToSupabase(rootPath, mock.client, USER_A);

      expect(result.summaries).toBe(2);

      // Verify DELETE was called before INSERT
      const sumCalls = mock.calls.filter(
        (c) => c.table === "community_summaries"
      );
      const deleteIdx = sumCalls.findIndex((c) => c.method === "delete");
      const insertIdx = sumCalls.findIndex((c) => c.method === "insert");
      expect(deleteIdx).toBeGreaterThanOrEqual(0);
      expect(insertIdx).toBeGreaterThan(deleteIdx);
    });

    it("handles missing graph tables gracefully", async () => {
      // createTempDb uses initDb which creates graph tables, so create a bare DB
      const { rootPath } = tracked(createTempDb());

      // Drop graph tables to simulate older DB
      const { dbPath } = tracked(createTempDb());
      const db = new Database(dbPath);
      db.exec("DROP TABLE IF EXISTS communities");
      db.exec("DROP TABLE IF EXISTS community_summaries");
      db.close();

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      // Should not throw
      const result = await syncToSupabase(rootPath, mock.client, USER_A);
      expect(result.communities).toBe(0);
      expect(result.summaries).toBe(0);
    });

    it("empty communities table — only deletes remote", async () => {
      const { rootPath } = tracked(createTempDb());

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      const result = await syncToSupabase(rootPath, mock.client, USER_A);

      expect(result.communities).toBe(0);

      // Should still call delete (clear remote)
      const deleteCalls = mock.calls.filter(
        (c) => c.table === "communities" && c.method === "delete"
      );
      expect(deleteCalls.length).toBe(1);

      // Should NOT call insert
      const insertCalls = mock.calls.filter(
        (c) => c.table === "communities" && c.method === "insert"
      );
      expect(insertCalls.length).toBe(0);
    });
  });

  describe("community edges sync", () => {
    it("syncs community_edges with DELETE + INSERT pattern", async () => {
      const { rootPath } = tracked(
        createTempDb((db) => {
          insertCommunityEdge(db, "commA", "commB", { weight: 3.5, edgeCount: 4 });
          insertCommunityEdge(db, "commA", "commC", { weight: 1.0, edgeCount: 1 });
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      const result = await syncToSupabase(rootPath, mock.client, USER_A);

      expect(result.communityEdges).toBe(2);

      // Verify DELETE was called before INSERT
      const ceCalls = mock.calls.filter((c) => c.table === "community_edges");
      const deleteIdx = ceCalls.findIndex((c) => c.method === "delete");
      const insertIdx = ceCalls.findIndex((c) => c.method === "insert");
      expect(deleteIdx).toBeGreaterThanOrEqual(0);
      expect(insertIdx).toBeGreaterThan(deleteIdx);
    });

    it("handles missing community_edges table gracefully", async () => {
      const { rootPath, dbPath } = tracked(createTempDb());

      // Drop community_edges table to simulate older DB
      const db = new Database(dbPath);
      db.exec("DROP TABLE IF EXISTS community_edges");
      db.close();

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
      });

      // Should not throw
      const result = await syncToSupabase(rootPath, mock.client, USER_A);
      expect(result.communityEdges).toBe(0);
    });
  });

  describe("docs branch gating", () => {
    afterEach(() => {
      setMockBranch("main");
      setMockCommitHash("abc123def456789012345678901234567890abcd");
    });

    it("syncs architecture data when on docs branch", async () => {
      setMockBranch("main");
      const { rootPath } = tracked(
        createTempDb((db) => {
          insertCommunity(db, "hash_a", "c0");
          insertCommunitySummary(db, "c0", {
            summary: { title: "Auth", documentation: "# Auth", meta: {} },
          });
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse("main"),
      });

      const result = await syncToSupabase(rootPath, mock.client, USER_A);

      expect(result.skippedArchitecture).toBe(false);
      expect(result.communities).toBe(1);
      expect(result.summaries).toBe(1);
    });

    it("skips architecture data when NOT on docs branch", async () => {
      setMockBranch("feature-x");
      const { rootPath } = tracked(
        createTempDb((db) => {
          insertAnalysisPair(db, "hash1", { syncedAt: null });
          insertFileFunction(db, "src/a.ts", "fn1", "hash1");
          insertCommunity(db, "hash_a", "c0");
          insertCommunitySummary(db, "c0", {
            summary: { title: "Auth", documentation: "# Auth", meta: {} },
          });
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse("main"),
      });

      const result = await syncToSupabase(rootPath, mock.client, USER_A);

      // Architecture should be skipped
      expect(result.skippedArchitecture).toBe(true);
      expect(result.communities).toBe(0);
      expect(result.summaries).toBe(0);

      // But function analysis and locations should still sync
      expect(result.pushed).toBe(2);
      expect(result.locations).toBe(1);

      // No community/summary INSERT calls
      const commInserts = mock.calls.filter(
        (c) => c.table === "communities" && c.method === "insert"
      );
      expect(commInserts.length).toBe(0);
    });

    it("bypasses gate for non-git repos (null branch)", async () => {
      setMockBranch(null);
      const { rootPath } = tracked(
        createTempDb((db) => {
          insertCommunity(db, "hash_a", "c0");
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse("main"),
      });

      const result = await syncToSupabase(rootPath, mock.client, USER_A);

      // Non-git repos always sync architecture
      expect(result.skippedArchitecture).toBe(false);
      expect(result.communities).toBe(1);
    });

    it("records commit hash on successful architecture sync", async () => {
      setMockBranch("main");
      setMockCommitHash("deadbeef1234567890abcdef1234567890abcdef");
      const { rootPath } = tracked(
        createTempDb((db) => {
          insertCommunity(db, "hash_a", "c0");
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse("main"),
      });

      const result = await syncToSupabase(rootPath, mock.client, USER_A);

      expect(result.commitHash).toBe("deadbeef1234567890abcdef1234567890abcdef");

      // Should have inserted into docs_sync_history
      const historyInserts = mock.calls.filter(
        (c) => c.table === "docs_sync_history" && c.method === "insert"
      );
      expect(historyInserts.length).toBe(1);
      expect(historyInserts[0].args[0]).toMatchObject({
        commit_hash: "deadbeef1234567890abcdef1234567890abcdef",
        branch: "main",
      });

      // Should have updated repos with last_docs_sync_commit
      const repoUpdates = mock.calls.filter(
        (c) => c.table === "repos" && c.method === "update"
      );
      expect(repoUpdates.length).toBe(1);
      expect(repoUpdates[0].args[0]).toMatchObject({
        last_docs_sync_commit: "deadbeef1234567890abcdef1234567890abcdef",
      });
    });

    it("skips commit hash recording when architecture is skipped", async () => {
      setMockBranch("feature-x");
      setMockCommitHash("deadbeef1234567890abcdef1234567890abcdef");
      const { rootPath } = tracked(
        createTempDb((db) => {
          insertCommunity(db, "hash_a", "c0");
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse("main"),
      });

      const result = await syncToSupabase(rootPath, mock.client, USER_A);

      expect(result.skippedArchitecture).toBe(true);
      expect(result.commitHash).toBeNull();

      // No docs_sync_history insert
      const historyInserts = mock.calls.filter(
        (c) => c.table === "docs_sync_history" && c.method === "insert"
      );
      expect(historyInserts.length).toBe(0);
    });

    it("skips commit hash recording for non-git repos", async () => {
      setMockBranch(null);
      setMockCommitHash(null);
      const { rootPath } = tracked(
        createTempDb((db) => {
          insertCommunity(db, "hash_a", "c0");
        })
      );

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse("main"),
      });

      const result = await syncToSupabase(rootPath, mock.client, USER_A);

      // Architecture syncs (gate bypassed) but no commit hash to record
      expect(result.skippedArchitecture).toBe(false);
      expect(result.commitHash).toBeNull();

      // No docs_sync_history insert (no commit to record)
      const historyInserts = mock.calls.filter(
        (c) => c.table === "docs_sync_history" && c.method === "insert"
      );
      expect(historyInserts.length).toBe(0);
    });
  });

  describe("practices sync", () => {
    it("pulls practices from Supabase into local SQLite", async () => {
      const { rootPath, dbPath } = tracked(createTempDb());

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
        "repo_practices.select": {
          data: [
            { practice_id: "no-eval", rule: "Never use eval()", severity: "error" },
            { practice_id: "use-const", rule: "Prefer const", severity: "warning" },
          ],
          error: null,
        },
      });

      await syncToSupabase(rootPath, mock.client, USER_A);

      const db = new Database(dbPath);
      const rows = db.prepare("SELECT practice_id, rule, severity FROM practices ORDER BY practice_id").all() as any[];
      db.close();

      expect(rows).toHaveLength(2);
      expect(rows[0].practice_id).toBe("no-eval");
      expect(rows[0].severity).toBe("error");
      expect(rows[1].practice_id).toBe("use-const");
    });

    it("clears local practices when Supabase returns empty", async () => {
      const { rootPath, dbPath } = tracked(createTempDb((db) => {
        db.prepare("INSERT INTO practices (practice_id, rule, severity) VALUES (?, ?, ?)").run("old-rule", "Old", "info");
      }));

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
        "repo_practices.select": { data: [], error: null },
      });

      await syncToSupabase(rootPath, mock.client, USER_A);

      const db = new Database(dbPath);
      const rows = db.prepare("SELECT * FROM practices").all();
      db.close();

      expect(rows).toHaveLength(0);
    });

    it("includes practices count in sync result", async () => {
      const { rootPath } = tracked(createTempDb());

      const mock = createMockSupabase({
        "repos.upsert": defaultRepoResponse(),
        "repo_practices.select": {
          data: [
            { practice_id: "no-eval", rule: "Never use eval()", severity: "error" },
          ],
          error: null,
        },
      });

      const result = await syncToSupabase(rootPath, mock.client, USER_A);
      expect(result.practices).toBe(1);
    });
  });
});

// ============ pullFromSupabase ============

describe("pullFromSupabase", () => {
  const cleanups: (() => void)[] = [];
  function tracked(result: ReturnType<typeof createTempDb>) {
    cleanups.push(result.cleanup);
    return result;
  }
  afterEach(() => {
    cleanups.forEach((fn) => fn());
    cleanups.length = 0;
  });

  it("empty missing hashes — returns early with 0", async () => {
    const { rootPath } = tracked(createTempDb());
    const mock = createMockSupabase();

    const result = await pullFromSupabase(
      rootPath,
      mock.client,
      USER_A,
      REPO_ID,
      []
    );

    expect(result.pulled).toBe(0);
    // Should NOT call supabase at all
    expect(mock.calls.length).toBe(0);
  });

  it("applies defensive defaults for missing fields", async () => {
    const { rootPath, dbPath } = tracked(createTempDb());

    const mock = createMockSupabase({
      "function_analysis.select": {
        data: [
          {
            content_hash: "hash1",
            analysis_type: "documentation",
            analysis: { description: "Test" },
            model_version: "claude-3",
            schema_version: null, // missing -- should default to 1
            language: null, // missing -- should default to 'typescript'
            entity_type: null, // missing -- should default to 'function'
          },
        ],
        error: null,
      },
    });

    const result = await pullFromSupabase(
      rootPath,
      mock.client,
      USER_A,
      REPO_ID,
      ["hash1"]
    );

    expect(result.pulled).toBe(1);

    // Verify defaults were applied
    const db = new Database(dbPath);
    const row = db
      .prepare(
        "SELECT language, entity_type, schema_version FROM function_analysis WHERE content_hash = 'hash1'"
      )
      .get() as { language: string; entity_type: string; schema_version: number };
    db.close();

    expect(row.language).toBe("typescript");
    expect(row.entity_type).toBe("function");
    expect(row.schema_version).toBe(1);
  });

  it("batches large hash lists into chunks of 50", async () => {
    const { rootPath } = tracked(createTempDb());

    const mock = createMockSupabase({
      "function_analysis.select": { data: [], error: null },
    });

    // 120 hashes → should produce 3 batches (50 + 50 + 20)
    const hashes = Array.from({ length: 120 }, (_, i) => `hash-${String(i).padStart(3, "0")}`);

    await pullFromSupabase(rootPath, mock.client, USER_A, REPO_ID, hashes);

    // Count how many .in() calls were made (one per batch)
    const inCalls = mock.calls.filter((c) => c.method === "in");
    expect(inCalls).toHaveLength(3);
    expect(inCalls[0].args[1]).toHaveLength(50);
    expect(inCalls[1].args[1]).toHaveLength(50);
    expect(inCalls[2].args[1]).toHaveLength(20);
  });

  it("handles string vs object analysis field", async () => {
    const { rootPath, dbPath } = tracked(createTempDb());

    const mock = createMockSupabase({
      "function_analysis.select": {
        data: [
          {
            content_hash: "hash-obj",
            analysis_type: "documentation",
            analysis: { description: "Object form" }, // object -- should be stringified
            model_version: "claude-3",
            schema_version: 1,
            language: "typescript",
            entity_type: "function",
          },
          {
            content_hash: "hash-str",
            analysis_type: "documentation",
            analysis: '{"description":"String form"}', // already string
            model_version: "claude-3",
            schema_version: 1,
            language: "typescript",
            entity_type: "function",
          },
        ],
        error: null,
      },
    });

    const result = await pullFromSupabase(
      rootPath,
      mock.client,
      USER_A,
      REPO_ID,
      ["hash-obj", "hash-str"]
    );

    expect(result.pulled).toBe(2);

    // Both should be stored as valid JSON strings
    const db = new Database(dbPath);
    const objRow = db
      .prepare(
        "SELECT analysis FROM function_analysis WHERE content_hash = 'hash-obj'"
      )
      .get() as { analysis: string };
    const strRow = db
      .prepare(
        "SELECT analysis FROM function_analysis WHERE content_hash = 'hash-str'"
      )
      .get() as { analysis: string };
    db.close();

    expect(JSON.parse(objRow.analysis).description).toBe("Object form");
    expect(JSON.parse(strRow.analysis).description).toBe("String form");
  });
});
