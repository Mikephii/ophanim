// Browser-mode query handler -- implements the same request methods as the
// extension host's webview-handler.ts, but queries the in-memory sql.js
// database loaded via data.ts. Enables `pnpm dev` testing without VS Code.

import type { Database } from "sql.js";
import { getAllFunctions, type FunctionData } from "./data";

let cachedDb: Database | null = null;

/** Register the database instance for browser queries */
export function setBrowserDb(database: Database): void {
  cachedDb = database;
}

/** Route a request method to the appropriate query */
export async function browserQueryHandler(
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case "getSecurityDashboardStats":
      return getSecurityDashboardStats();
    case "getTopIssues":
      return getTopIssues((params?.limit as number) ?? 8);
    case "getSecurityIssues":
      return getSecurityIssues(params);
    case "getEnrichedFunctions":
      return getEnrichedFunctions(params);
    case "getEnrichedFunction":
      return getEnrichedFunction(params?.contentHash as string);
    case "getAvailableLanguages":
      return getAvailableLanguages();
    case "resolveCurrentHash":
      return resolveCurrentHash(params?.functionName as string, params?.filePath as string);
    case "getNavCounts":
      return getNavCounts();
    case "getPractices":
      return getPractices();
    case "getArchitectureHierarchy":
      return getArchitectureHierarchy();
    case "getCommunityDetail":
    case "getGroupDetail":
    case "getConcernDetail":
    case "getConcernsIndex":
      return null;
    case "getGraphData":
      return getGraphData();
    case "dismissIssue":
    case "undismissIssue":
      return null;
    case "getStatus":
      return {
        mode: "browser" as const,
        watchRunning: false,
        watchError: null,
        analyzingFile: null,
        scanProgress: null,
        retryState: null,
        staleFiles: [],
        staleCount: 0,
        recentErrorCount: 0,
        activityLog: [],
      };
    case "analyzeNow":
    case "openOutput":
    case "openFile":
      return null;
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function severityScore(severity: string): number {
  switch (severity) {
    case "error": return 3;
    case "warning": return 2;
    case "info": return 1;
    default: return 0;
  }
}

function confidenceScore(confidence?: string): number {
  switch (confidence) {
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
    default: return 2;
  }
}

function priorityScore(severity: string, confidence?: string): number {
  return severityScore(severity) * 3 + confidenceScore(confidence);
}

type MergedAnalysis = {
  documentation: { description: string; params: unknown[]; returns: unknown };
  security: { dataTags: string[]; securityFlags: string[]; issues: unknown[] };
  practices: { violations: unknown[] };
};

function toEnriched(fn: FunctionData) {
  return {
    file_path: fn.filePath,
    function_name: fn.name,
    content_hash: fn.contentHash,
    language: fn.language,
    entity_type: fn.entityType,
    start_line: fn.startLine,
    analysis: {
      documentation: {
        description: fn.description,
        params: fn.params,
        returns: fn.returns,
      },
      security: {
        dataTags: fn.dataTags,
        securityFlags: fn.securityFlags,
        issues: fn.issues,
      },
      practices: {
        violations: fn.practiceViolations,
      },
    } as MergedAnalysis,
  };
}

// ── Query implementations ────────────────────────────────────────────

function getSecurityDashboardStats() {
  const all = getAllFunctions();
  let criticalCount = 0;
  let errorCount = 0;
  let warningCount = 0;
  const flagBreakdown: Record<string, { count: number; errorCount: number; warningCount: number; infoCount: number }> = {};

  for (const fn of all) {
    for (const issue of fn.issues) {
      const flag = issue.flag;
      if (!flagBreakdown[flag]) {
        flagBreakdown[flag] = { count: 0, errorCount: 0, warningCount: 0, infoCount: 0 };
      }
      flagBreakdown[flag].count++;
      if (issue.severity === "error") {
        flagBreakdown[flag].errorCount++;
        // Check priority for "critical"
        const score = priorityScore(issue.severity, (issue as { confidence?: string }).confidence);
        if (score >= 10) criticalCount++;
        else errorCount++;
      } else if (issue.severity === "warning") {
        flagBreakdown[flag].warningCount++;
        warningCount++;
      } else {
        flagBreakdown[flag].infoCount++;
      }
    }
  }

  const posture: "critical" | "warning" | "clean" =
    criticalCount > 0 ? "critical" : errorCount > 0 || warningCount > 0 ? "warning" : "clean";

  return {
    posture,
    criticalCount,
    errorCount,
    warningCount,
    totalFunctions: all.length,
    flagBreakdown,
  };
}

function getTopIssues(limit: number) {
  const all = getAllFunctions();
  const items: { content_hash: string; function_name: string; file_path: string; issue: unknown; score: number }[] = [];

  for (const fn of all) {
    for (const issue of fn.issues) {
      items.push({
        content_hash: fn.contentHash,
        function_name: fn.name,
        file_path: fn.filePath,
        issue,
        score: priorityScore(issue.severity, (issue as { confidence?: string }).confidence),
      });
    }
  }

  items.sort((a, b) => b.score - a.score);
  return items.slice(0, limit);
}

function getSecurityIssues(params?: Record<string, unknown>) {
  const flag = params?.flag as string | undefined;
  const severity = params?.severity as string | undefined;
  const page = (params?.page as number) || 1;
  const pageSize = (params?.pageSize as number) || 20;

  const all = getAllFunctions();
  const items: unknown[] = [];

  for (const fn of all) {
    fn.issues.forEach((issue, idx) => {
      if (flag && issue.flag !== flag) return;
      if (severity && issue.severity !== severity) return;
      items.push({
        content_hash: fn.contentHash,
        function_name: fn.name,
        file_path: fn.filePath,
        language: fn.language,
        entity_type: fn.entityType,
        start_line: fn.startLine,
        issue,
        issueIndex: idx,
        score: priorityScore(issue.severity, (issue as { confidence?: string }).confidence),
        dismissed: false,
      });
    });
  }

  // Sort by score descending
  items.sort((a: any, b: any) => b.score - a.score);

  const total = items.length;
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total, page };
}

function getEnrichedFunctions(params?: Record<string, unknown>) {
  const search = (params?.search as string)?.toLowerCase();
  const language = params?.language as string | undefined;
  const securityOnly = params?.securityOnly as boolean;
  const page = (params?.page as number) || 1;
  const pageSize = (params?.pageSize as number) || 20;

  let all = getAllFunctions();

  if (search) {
    all = all.filter(
      fn => fn.name.toLowerCase().includes(search) ||
            fn.filePath.toLowerCase().includes(search),
    );
  }
  if (language) {
    all = all.filter(fn => fn.language === language);
  }
  if (securityOnly) {
    all = all.filter(fn => fn.issues.length > 0);
  }

  const total = all.length;
  const start = (page - 1) * pageSize;
  const items = all.slice(start, start + pageSize).map(toEnriched);
  return { items, total, page };
}

function getEnrichedFunction(contentHash: string) {
  const all = getAllFunctions();
  const fn = all.find(f => f.contentHash === contentHash);
  if (!fn) return null;
  return toEnriched(fn);
}

function resolveCurrentHash(functionName: string, filePath: string) {
  if (!functionName || !filePath) return null;
  const all = getAllFunctions();
  const fn = all.find(f => f.name === functionName && f.filePath === filePath);
  if (!fn) return null;
  return { contentHash: fn.contentHash };
}

function getAvailableLanguages() {
  const all = getAllFunctions();
  return [...new Set(all.map(f => f.language))].sort();
}

function getNavCounts() {
  const all = getAllFunctions();
  let securityIssues = 0;
  for (const fn of all) {
    securityIssues += fn.issues.length;
  }
  return {
    securityIssues,
    functions: all.length,
    practices: 0,
  };
}

function getPractices() {
  if (!cachedDb) return [];
  try {
    const stmt = cachedDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='practices'",
    );
    const exists = stmt.step();
    stmt.free();
    if (!exists) return [];

    const results: { practice_id: string; rule: string; severity: string }[] = [];
    const pStmt = cachedDb.prepare("SELECT practice_id, rule, severity FROM practices");
    while (pStmt.step()) {
      const row = pStmt.getAsObject();
      results.push({
        practice_id: row.practice_id as string,
        rule: row.rule as string,
        severity: (row.severity as string) || "warning",
      });
    }
    pStmt.free();
    return results;
  } catch {
    return [];
  }
}

function getGraphData() {
  if (!cachedDb) return null;

  // Check if function_edges table exists
  try {
    const check = cachedDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='function_edges'",
    );
    const exists = check.step();
    check.free();
    if (!exists) return null;
  } catch {
    return null;
  }

  // Build hash→function lookup from getAllFunctions()
  const allFunctions = getAllFunctions();
  const hashToFn = new Map<string, FunctionData>();
  for (const fn of allFunctions) {
    hashToFn.set(fn.contentHash, fn);
  }

  // Load edges, filtering to functions that exist in the codebase
  const edgeNodeHashes = new Set<string>();
  const edges: { source: string; target: string; edgeType: string; weight: number }[] = [];
  try {
    const stmt = cachedDb.prepare(
      "SELECT source_hash, target_hash, edge_type, weight FROM function_edges",
    );
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        source_hash: string; target_hash: string; edge_type: string; weight: number;
      };
      if (!hashToFn.has(row.source_hash) || !hashToFn.has(row.target_hash)) continue;
      edgeNodeHashes.add(row.source_hash);
      edgeNodeHashes.add(row.target_hash);
      edges.push({
        source: row.source_hash,
        target: row.target_hash,
        edgeType: row.edge_type,
        weight: row.weight,
      });
    }
    stmt.free();
  } catch {
    return null;
  }

  if (edgeNodeHashes.size === 0) return null;

  // Load L0 community assignments
  const hashToCommunity = new Map<string, string>();
  try {
    const check = cachedDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='communities'",
    );
    const exists = check.step();
    check.free();
    if (exists) {
      const stmt = cachedDb.prepare(
        "SELECT content_hash, community_id FROM communities WHERE level = 0",
      );
      while (stmt.step()) {
        const row = stmt.getAsObject() as { content_hash: string; community_id: string };
        hashToCommunity.set(row.content_hash, row.community_id);
      }
      stmt.free();
    }
  } catch {
    // Ignore -- communities may not exist yet
  }

  // Build nodes
  const nodes = [];
  for (const hash of edgeNodeHashes) {
    const fn = hashToFn.get(hash)!;
    nodes.push({
      id: hash,
      label: fn.name,
      filePath: fn.filePath,
      communityId: hashToCommunity.get(hash) ?? "",
      description: fn.description,
      securityFlags: fn.securityFlags,
      issueCount: fn.issues.length,
    });
  }

  // Build community summaries for active communities
  const activeCommunityIds = new Set(
    nodes.map((n) => n.communityId).filter(Boolean),
  );
  const communities: { communityId: string; title: string; memberCount: number }[] = [];

  if (activeCommunityIds.size > 0) {
    const memberCounts = new Map<string, number>();
    for (const node of nodes) {
      if (node.communityId) {
        memberCounts.set(node.communityId, (memberCounts.get(node.communityId) ?? 0) + 1);
      }
    }

    try {
      const check = cachedDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='community_summaries'",
      );
      const exists = check.step();
      check.free();
      if (exists) {
        const stmt = cachedDb.prepare(
          "SELECT community_id, summary FROM community_summaries WHERE level = 1",
        );
        while (stmt.step()) {
          const row = stmt.getAsObject() as { community_id: string; summary: string };
          if (!activeCommunityIds.has(row.community_id)) continue;
          let title = row.community_id;
          try {
            const s = typeof row.summary === "string" ? JSON.parse(row.summary) : row.summary;
            title = (s as Record<string, unknown>).title as string ?? row.community_id;
          } catch {
            // Keep default
          }
          communities.push({
            communityId: row.community_id,
            title,
            memberCount: memberCounts.get(row.community_id) ?? 0,
          });
        }
        stmt.free();
      }
    } catch {
      // Ignore
    }
  }

  return { nodes, edges, communities };
}

function getArchitectureHierarchy() {
  if (!cachedDb) return null;
  try {
    const stmt = cachedDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='community_summaries'",
    );
    const exists = stmt.step();
    stmt.free();
    if (!exists) return null;

    // Simplified: return basic hierarchy
    return { l3: null, groups: [], ungrouped: [], crossCutting: [] };
  } catch {
    return null;
  }
}
