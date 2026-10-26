import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { createTestDb } from "@ophan/core/test-utils";

/**
 * Creates a temp directory with a real .ophan/index.db file.
 * Sync functions take rootPath and construct dbPath internally,
 * so we need an actual file on disk.
 */
export function createTempDb(
  setup?: (db: Database.Database) => void
): { dbPath: string; rootPath: string; cleanup: () => void } {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ophan-test-"));
  const ophanDir = path.join(rootPath, ".ophan");
  fs.mkdirSync(ophanDir, { recursive: true });
  const dbPath = path.join(ophanDir, "index.db");

  // Create a real file-based DB with the current schema
  const memDb = createTestDb();

  // Serialize the in-memory DB to a file
  const db = new Database(dbPath);
  db.exec(memDb.prepare("SELECT sql FROM sqlite_master WHERE type='table'")
    .all()
    .map((row: any) => row.sql + ";")
    .join("\n"));

  // Run setup callback if provided
  if (setup) setup(db);
  db.close();
  memDb.close();

  return {
    dbPath,
    rootPath,
    cleanup: () => {
      try {
        fs.rmSync(rootPath, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

type MockChainResponse = { data: any; error: any; count?: number };

/**
 * Creates a mock Supabase client that records calls and returns controlled responses.
 *
 * Usage:
 *   const mock = createMockSupabase({
 *     'repos.upsert': { data: [{ id: 'repo-1' }], error: null },
 *     'function_analysis.select': { data: [], error: null },
 *   })
 *   await syncToSupabase(rootPath, mock.client, userId)
 *   expect(mock.calls).toContainEqual(expect.objectContaining({ table: 'repos', method: 'upsert' }))
 */
export function createMockSupabase(
  responses: Record<string, MockChainResponse> = {}
) {
  const calls: { table: string; method: string; args: any[] }[] = [];

  function createChain(table: string): any {
    let primaryMethod = "";

    const resolve = () => {
      const key = `${table}.${primaryMethod}`;
      return responses[key] ?? { data: [], error: null };
    };

    const chain: Record<string, any> = {};
    const handler: ProxyHandler<Record<string, any>> = {
      get(_, prop: string) {
        // Primary operations
        if (
          ["select", "insert", "upsert", "update", "delete"].includes(prop)
        ) {
          return (...args: any[]) => {
            primaryMethod = prop;
            calls.push({ table, method: prop, args });
            return new Proxy(chain, handler);
          };
        }
        // Filter/modifier methods -- chainable
        if (
          [
            "eq",
            "in",
            "neq",
            "gt",
            "lt",
            "gte",
            "lte",
            "like",
            "ilike",
            "contains",
            "order",
            "limit",
            "range",
            "or",
            "not",
            "is",
            "head",
          ].includes(prop)
        ) {
          return (...args: any[]) => {
            calls.push({ table, method: prop, args });
            return new Proxy(chain, handler);
          };
        }
        // Terminal methods
        if (prop === "single" || prop === "maybeSingle") {
          return (...args: any[]) => {
            calls.push({ table, method: prop, args });
            return Promise.resolve(resolve());
          };
        }
        // Thenable -- allows `await supabase.from(...).select(...).eq(...)`
        if (prop === "then") {
          const result = resolve();
          return Promise.resolve(result).then.bind(Promise.resolve(result));
        }
        return new Proxy(chain, handler);
      },
    };

    return new Proxy(chain, handler);
  }

  const client = {
    from: (table: string) => {
      calls.push({ table, method: "from", args: [table] });
      return createChain(table);
    },
  };

  return { client: client as any, calls };
}
