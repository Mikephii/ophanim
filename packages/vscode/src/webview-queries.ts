// Webview query implementations for the extension host.
//
// These functions run against the local better-sqlite3 database and are called
// by webview-handler.ts to respond to DataRequest messages from the webview.
//
// Single database engine:
//   db -- better-sqlite3 (native), used for all reads and writes against index.db
//
// All queries (analysis reads, state reads, state writes) use the same
// better-sqlite3 handle for simplicity and immediate read-after-write consistency.

import type BetterDatabase from "better-sqlite3";

// ── Types ────────────────────────────────────────────────────────────

/** Per-flag breakdown with severity detail */
export type FlagBreakdownEntry = {
  count: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
};

/** Security dashboard aggregate stats */
export type SecurityDashboardStats = {
  posture: "critical" | "warning" | "clean";
  criticalCount: number;
  errorCount: number;
  warningCount: number;
  totalFunctions: number;
  flagBreakdown: Record<string, FlagBreakdownEntry>;
};

/** Merged analysis for a single function */
export type MergedAnalysis = {
  documentation: {
    description: string;
    params: { name: string; type: string; description: string }[];
    returns: { type: string; description: string };
  };
  security: {
    dataTags: string[];
    securityFlags: string[];
    issues: {
      flag: string;
      title: string;
      description: string;
      explanation: string;
      line: number;
      startText: string;
      endText: string;
      severity: string;
      confidence?: string;
    }[];
  };
  practices: {
    violations: {
      flag: string;
      title: string;
      description: string;
      explanation: string;
      line: number;
      startText: string;
      endText: string;
      severity: string;
    }[];
  };
};

/** Enriched function with location + merged analysis */
export type EnrichedFunction = {
  file_path: string;
  function_name: string;
  content_hash: string;
  language: string;
  entity_type: string;
  start_line: number;
  analysis: MergedAnalysis;
  /** Per-issue edit state (keyed "security:0", "practice:1", etc.) */
  editState?: Record<string, { adjustedLine: number; potentiallyRemediated: boolean }>;
};

// ── Scoring helpers (inline to avoid cross-package dep) ──────────────

function severityScore(severity: string): number {
  return severity === "error" ? 3 : severity === "warning" ? 2 : 1;
}

function confidenceScore(confidence: string): number {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}

function priorityScore(severity: string, confidence: string): number {
  return severityScore(severity) * 3 + confidenceScore(confidence);
}

// ── Table utilities ──────────────────────────────────────────────────

/** Check if a table exists in the database */
export function tableExists(db: BetterDatabase.Database, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  return row !== undefined;
}

// ── Merge helpers ────────────────────────────────────────────────────

const EMPTY_ANALYSIS: MergedAnalysis = {
  documentation: { description: "", params: [], returns: { type: "unknown", description: "" } },
  security: { dataTags: [], securityFlags: [], issues: [] },
  practices: { violations: [] },
};

/** Merge analysis rows for a single content_hash into MergedAnalysis */
function mergeAnalysisRows(
  rows: { analysis_type: string; analysis: Record<string, unknown> }[],
): MergedAnalysis {
  let doc = EMPTY_ANALYSIS.documentation;
  let sec = EMPTY_ANALYSIS.security;
  let prac = EMPTY_ANALYSIS.practices;

  for (const row of rows) {
    const a = (row.analysis ?? {}) as Record<string, unknown>;
    if (row.analysis_type === "documentation") {
      doc = {
        description: (a.description as string) ?? "",
        params: (a.params as MergedAnalysis["documentation"]["params"]) ?? [],
        returns: (a.returns as MergedAnalysis["documentation"]["returns"]) ?? { type: "unknown", description: "" },
      };
    } else if (row.analysis_type === "security") {
      sec = {
        dataTags: (a.dataTags as string[]) ?? [],
        securityFlags: (a.securityFlags as string[]) ?? [],
        issues: (a.issues as MergedAnalysis["security"]["issues"]) ?? [],
      };
    } else if (row.analysis_type === "practices") {
      prac = {
        violations: (a.violations as MergedAnalysis["practices"]["violations"]) ?? [],
      };
    }
  }

  return { documentation: doc, security: sec, practices: prac };
}

// ── Navigation counts ────────────────────────────────────────────────

/** Navigation menu counts */
export function getNavCounts(db: BetterDatabase.Database): {
  securityIssues: number;
  functions: number;
  practices: number;
} {
  let securityIssues = 0;
  let functions = 0;
  let practices = 0;

  // Count distinct functions in file_functions
  try {
    const row = db.prepare(
      "SELECT COUNT(DISTINCT content_hash) as c FROM file_functions"
    ).get() as { c: number } | undefined;
    if (row) {
      functions = row.c;
    }
  } catch {
    // Table may not exist
  }

  // Count security issues across all function_analysis rows
  try {
    const rows = db.prepare(
      "SELECT analysis FROM function_analysis WHERE analysis_type = 'security'"
    ).all() as { analysis: string }[];
    for (const row of rows) {
      try {
        const analysis = JSON.parse(row.analysis);
        const issues = analysis.issues;
        if (Array.isArray(issues)) {
          securityIssues += issues.length;
        }
      } catch {
        // Malformed JSON -- skip
      }
    }
  } catch {
    // Table may not exist
  }

  // Count practices
  if (tableExists(db, "practices")) {
    try {
      const row = db.prepare("SELECT COUNT(*) as c FROM practices").get() as { c: number } | undefined;
      if (row) {
        practices = row.c;
      }
    } catch {
      // Ignore
    }
  }

  return { securityIssues, functions, practices };
}

// ── Security Dashboard Stats ─────────────────────────────────────────

/** Get aggregate security stats for the dashboard home view */
export function getSecurityDashboardStats(db: BetterDatabase.Database): SecurityDashboardStats {
  let criticalCount = 0;
  let errorCount = 0;
  let warningCount = 0;
  let totalFunctions = 0;
  const flagBreakdown: Record<string, FlagBreakdownEntry> = {};

  const dismissedSet = getDismissedSet(db);

  // Total functions
  try {
    const row = db.prepare(
      "SELECT COUNT(DISTINCT content_hash) as c FROM file_functions"
    ).get() as { c: number } | undefined;
    if (row) {
      totalFunctions = row.c;
    }
  } catch {
    // Table may not exist
  }

  // Iterate security analysis rows
  try {
    const rows = db.prepare(
      "SELECT content_hash, analysis FROM function_analysis WHERE analysis_type = 'security'"
    ).all() as { content_hash: string; analysis: string }[];
    for (const row of rows) {
      const contentHash = row.content_hash;
      try {
        const analysis = JSON.parse(row.analysis);
        const issues = analysis.issues ?? [];

        for (let i = 0; i < issues.length; i++) {
          if (dismissedSet.has(`${contentHash}:${i}`)) continue;

          const issue = issues[i];
          const severity = issue.severity ?? "warning";
          const confidence = issue.confidence ?? "medium";
          const flag = issue.flag ?? "unknown";

          if (severity === "error") {
            errorCount++;
            if (confidence === "high") criticalCount++;
          } else if (severity === "warning") {
            warningCount++;
          }

          if (!flagBreakdown[flag]) {
            flagBreakdown[flag] = { count: 0, errorCount: 0, warningCount: 0, infoCount: 0 };
          }
          flagBreakdown[flag].count++;
          if (severity === "error") flagBreakdown[flag].errorCount++;
          else if (severity === "warning") flagBreakdown[flag].warningCount++;
          else flagBreakdown[flag].infoCount++;
        }

        // v1 rows: flags but no issues array
        if (issues.length === 0) {
          const flags = analysis.securityFlags ?? [];
          for (const flag of flags) {
            warningCount++;
            if (!flagBreakdown[flag]) {
              flagBreakdown[flag] = { count: 0, errorCount: 0, warningCount: 0, infoCount: 0 };
            }
            flagBreakdown[flag].count++;
            flagBreakdown[flag].warningCount++;
          }
        }
      } catch {
        // Malformed JSON -- skip
      }
    }
  } catch {
    // Table may not exist
  }

  const posture: SecurityDashboardStats["posture"] =
    criticalCount > 0 ? "critical" : errorCount + warningCount > 0 ? "warning" : "clean";

  return { posture, criticalCount, errorCount, warningCount, totalFunctions, flagBreakdown };
}

// ── Top Issues ───────────────────────────────────────────────────────

type TopIssueItem = {
  content_hash: string;
  function_name: string;
  file_path: string;
  language: string;
  entity_type: string;
  start_line: number;
  issue: MergedAnalysis["security"]["issues"][number];
  issueIndex: number;
  score: number;
};

/** Get top N security issues sorted by priority score */
export function getTopIssues(db: BetterDatabase.Database, limit = 8): TopIssueItem[] {
  const dismissedSet = getDismissedSet(db);
  const items: TopIssueItem[] = [];

  // Build a content_hash → file info lookup
  const hashToLocation = buildHashToLocation(db);

  // Iterate security rows, flatten issues, score them
  try {
    const rows = db.prepare(
      "SELECT content_hash, analysis FROM function_analysis WHERE analysis_type = 'security'"
    ).all() as { content_hash: string; analysis: string }[];
    for (const row of rows) {
      const contentHash = row.content_hash;
      const loc = hashToLocation.get(contentHash);
      if (!loc) continue;

      try {
        const analysis = JSON.parse(row.analysis);
        const issues = analysis.issues ?? [];

        for (let i = 0; i < issues.length; i++) {
          if (dismissedSet.has(`${contentHash}:${i}`)) continue;
          const issue = issues[i];
          const score = priorityScore(issue.severity ?? "warning", issue.confidence ?? "medium");
          items.push({
            content_hash: contentHash,
            function_name: loc.function_name,
            file_path: loc.file_path,
            language: loc.language,
            entity_type: loc.entity_type,
            start_line: loc.start_line,
            issue,
            issueIndex: i,
            score,
          });
        }
      } catch {
        // Malformed JSON -- skip
      }
    }
  } catch {
    // Table may not exist
  }

  // Sort by score descending, take top N
  items.sort((a, b) => b.score - a.score);
  return items.slice(0, limit);
}

// ── Enriched Functions (paginated) ───────────────────────────────────

type EnrichedFunctionsParams = {
  search?: string;
  language?: string;
  securityOnly?: boolean;
  page?: number;
  pageSize?: number;
};

/** Get paginated enriched functions with optional search/filter */
export function getEnrichedFunctions(
  db: BetterDatabase.Database,
  params?: EnrichedFunctionsParams,
): { items: EnrichedFunction[]; total: number; page: number } {
  const page = params?.page ?? 1;
  const pageSize = params?.pageSize ?? 20;
  const search = params?.search?.toLowerCase();
  const language = params?.language;
  const securityOnly = params?.securityOnly ?? false;

  // Collect all file_functions rows (with optional SQL-level filters)
  const conditions: string[] = [];
  const binds: (string | number)[] = [];

  if (language) {
    conditions.push("ff.language = ?");
    binds.push(language);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Get distinct functions with location info
  type FnRow = { file_path: string; function_name: string; content_hash: string; language: string; entity_type: string; start_line: number };
  const fnRows: FnRow[] = [];
  const seenHashes = new Set<string>();

  try {
    const rows = db.prepare(
      `SELECT file_path, function_name, content_hash, language, entity_type, start_line
       FROM file_functions ff ${where}
       ORDER BY file_path, function_name`
    ).all(...binds) as { file_path: string; function_name: string; content_hash: string; language: string; entity_type: string; start_line: number }[];

    for (const row of rows) {
      const hash = row.content_hash;
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      fnRows.push({
        file_path: row.file_path,
        function_name: row.function_name,
        content_hash: hash,
        language: row.language || "typescript",
        entity_type: row.entity_type || "function",
        start_line: row.start_line || 0,
      });
    }
  } catch {
    return { items: [], total: 0, page };
  }

  // Build analysis map for all hashes
  const analysisMap = buildAnalysisMapFromDb(db, seenHashes);

  // Apply JS-level filters (search, securityOnly)
  let filtered = fnRows;

  if (search) {
    filtered = filtered.filter(
      (r) =>
        r.function_name.toLowerCase().includes(search) ||
        r.file_path.toLowerCase().includes(search),
    );
  }

  if (securityOnly) {
    filtered = filtered.filter((r) => {
      const a = analysisMap.get(r.content_hash);
      return a && a.security.issues.length > 0;
    });
  }

  const total = filtered.length;
  const offset = (page - 1) * pageSize;
  const pageItems = filtered.slice(offset, offset + pageSize);

  const items: EnrichedFunction[] = pageItems.map((r) => ({
    file_path: r.file_path,
    function_name: r.function_name,
    content_hash: r.content_hash,
    language: r.language,
    entity_type: r.entity_type,
    start_line: r.start_line,
    analysis: analysisMap.get(r.content_hash) ?? EMPTY_ANALYSIS,
  }));

  return { items, total, page };
}

// ── Single Enriched Function ─────────────────────────────────────────

/** Get a single enriched function by content hash */
export function getEnrichedFunction(
  db: BetterDatabase.Database,
  contentHash: string,
): EnrichedFunction | null {
  // Get location info
  let loc: { file_path: string; function_name: string; language: string; entity_type: string; start_line: number } | null = null;
  try {
    const row = db.prepare(
      "SELECT file_path, function_name, language, entity_type, start_line FROM file_functions WHERE content_hash = ? LIMIT 1"
    ).get(contentHash) as { file_path: string; function_name: string; language: string; entity_type: string; start_line: number } | undefined;
    if (row) {
      loc = {
        file_path: row.file_path,
        function_name: row.function_name,
        language: row.language || "typescript",
        entity_type: row.entity_type || "function",
        start_line: row.start_line || 0,
      };
    }
  } catch {
    return null;
  }

  if (!loc) return null;

  // Get analysis rows
  const analysisRows: { analysis_type: string; analysis: Record<string, unknown> }[] = [];
  try {
    const rows = db.prepare(
      "SELECT analysis_type, analysis FROM function_analysis WHERE content_hash = ?"
    ).all(contentHash) as { analysis_type: string; analysis: string }[];
    for (const row of rows) {
      try {
        analysisRows.push({
          analysis_type: row.analysis_type,
          analysis: JSON.parse(row.analysis),
        });
      } catch {
        // Malformed JSON -- skip
      }
    }
  } catch {
    // Table may not exist
  }

  // Build edit state map for this hash
  const editStateMap = getEditStateMap(db);
  let editState: EnrichedFunction["editState"];
  for (const [key, entry] of editStateMap) {
    if (key.startsWith(`${contentHash}:`)) {
      const suffix = key.slice(contentHash.length + 1); // "security:0", "practice:1"
      if (!editState) editState = {};
      editState[suffix] = entry;
    }
  }

  return {
    ...loc,
    content_hash: contentHash,
    analysis: mergeAnalysisRows(analysisRows),
    editState,
  };
}

// ── Resolve Current Hash ─────────────────────────────────────────────

/** Resolve the current content hash for a function by name + file path.
 *  Used when the panel holds a stale hash after re-analysis. */
export function resolveCurrentHash(
  db: BetterDatabase.Database,
  functionName: string,
  filePath: string,
): { contentHash: string } | null {
  if (!functionName || !filePath) return null;
  try {
    const row = db.prepare(
      "SELECT content_hash FROM file_functions WHERE function_name = ? AND file_path = ? LIMIT 1"
    ).get(functionName, filePath) as { content_hash: string } | undefined;
    if (row) return { contentHash: row.content_hash };
  } catch {
    // Table may not exist
  }
  return null;
}

// ── Available Languages ──────────────────────────────────────────────

/** Get distinct languages from file_functions */
export function getAvailableLanguages(db: BetterDatabase.Database): string[] {
  const languages: string[] = [];
  try {
    const rows = db.prepare(
      "SELECT DISTINCT language FROM file_functions ORDER BY language"
    ).all() as { language: string }[];
    for (const row of rows) {
      languages.push(row.language);
    }
  } catch {
    // Table may not exist
  }
  return languages;
}

// ── Dismissed Issues Helper ──────────────────────────────────────────

/** Build set of dismissed issue keys ("content_hash:issue_index") */
function getDismissedSet(db?: BetterDatabase.Database | null): Set<string> {
  const set = new Set<string>();
  if (!db) return set;

  try {
    const rows = db
      .prepare("SELECT content_hash, issue_index FROM dismissed_issues")
      .all() as { content_hash: string; issue_index: number }[];
    for (const row of rows) {
      set.add(`${row.content_hash}:${row.issue_index}`);
    }
  } catch {
    // Table may not exist yet
  }
  return set;
}

// ── Edit State Helper ────────────────────────────────────────────────

type EditStateEntry = {
  adjustedLine: number;
  potentiallyRemediated: boolean;
};

/** Build map of edit state entries ("hash:type:index" → state) */
export function getEditStateMap(db?: BetterDatabase.Database | null): Map<string, EditStateEntry> {
  const map = new Map<string, EditStateEntry>();
  if (!db) return map;

  try {
    const rows = db
      .prepare(
        "SELECT content_hash, issue_type, issue_index, adjusted_line, potentially_remediated FROM issue_edit_state",
      )
      .all() as {
      content_hash: string;
      issue_type: string;
      issue_index: number;
      adjusted_line: number;
      potentially_remediated: number;
    }[];
    for (const row of rows) {
      const key = `${row.content_hash}:${row.issue_type}:${row.issue_index}`;
      map.set(key, {
        adjustedLine: row.adjusted_line,
        potentiallyRemediated: row.potentially_remediated === 1,
      });
    }
  } catch {
    // Table may not exist yet
  }
  return map;
}

// ── Security Issues (paginated, filtered) ────────────────────────

export type SecurityIssueItem = {
  content_hash: string;
  function_name: string;
  file_path: string;
  language: string;
  entity_type: string;
  start_line: number;
  issue: MergedAnalysis["security"]["issues"][number];
  issueIndex: number;
  score: number;
  dismissed: boolean;
  adjustedLine?: number;
  potentiallyRemediated: boolean;
};

type SecurityIssuesParams = {
  flag?: string;
  severity?: string;
  dataTag?: string;
  showDismissed?: boolean;
  page?: number;
  pageSize?: number;
};

/** Get paginated, filtered security issues */
export function getSecurityIssues(
  db: BetterDatabase.Database,
  params?: SecurityIssuesParams,
): { items: SecurityIssueItem[]; total: number; page: number } {
  const page = params?.page ?? 1;
  const pageSize = params?.pageSize ?? 20;
  const flagFilter = params?.flag;
  const severityFilter = params?.severity;
  const dataTagFilter = params?.dataTag;
  const showDismissed = params?.showDismissed ?? false;

  const dismissedSet = getDismissedSet(db);
  const editStateMap = getEditStateMap(db);
  const hashToLocation = buildHashToLocation(db);
  const items: SecurityIssueItem[] = [];

  // Build dataTag lookup if filtering by dataTag
  const hashDataTags = new Map<string, string[]>();

  // Iterate security rows, flatten all issues
  try {
    const rows = db.prepare(
      "SELECT content_hash, analysis FROM function_analysis WHERE analysis_type = 'security'",
    ).all() as { content_hash: string; analysis: string }[];
    for (const row of rows) {
      const contentHash = row.content_hash;
      const loc = hashToLocation.get(contentHash);
      if (!loc) continue;

      try {
        const analysis = JSON.parse(row.analysis);
        const issues = analysis.issues ?? [];
        const dataTags: string[] = analysis.dataTags ?? [];
        hashDataTags.set(contentHash, dataTags);

        for (let i = 0; i < issues.length; i++) {
          const isDismissed = dismissedSet.has(`${contentHash}:${i}`);
          if (isDismissed && !showDismissed) continue;

          const issue = issues[i];
          const severity = issue.severity ?? "warning";
          const flag = issue.flag ?? "unknown";

          // Apply filters
          if (flagFilter && flag !== flagFilter) continue;
          if (severityFilter && severity !== severityFilter) continue;
          if (dataTagFilter && !dataTags.includes(dataTagFilter)) continue;

          const editKey = `${contentHash}:security:${i}`;
          const editState = editStateMap.get(editKey);

          const score = priorityScore(severity, issue.confidence ?? "medium");
          items.push({
            content_hash: contentHash,
            function_name: loc.function_name,
            file_path: loc.file_path,
            language: loc.language,
            entity_type: loc.entity_type,
            start_line: loc.start_line,
            issue,
            issueIndex: i,
            score,
            dismissed: isDismissed,
            adjustedLine: editState?.adjustedLine,
            potentiallyRemediated: editState?.potentiallyRemediated ?? false,
          });
        }
      } catch {
        // Malformed JSON -- skip
      }
    }
  } catch {
    // Table may not exist
  }

  // Sort by score descending
  items.sort((a, b) => b.score - a.score);

  const total = items.length;
  const offset = (page - 1) * pageSize;
  const pageItems = items.slice(offset, offset + pageSize);

  return { items: pageItems, total, page };
}

// ── Dismiss / Undismiss ──────────────────────────────────────────

type DismissParams = {
  contentHash: string;
  issueIndex: number;
  flag: string;
  reason: string;
  note?: string;
};

/** Dismiss a security issue. Writes to index.db via better-sqlite3. */
export function dismissIssue(db: BetterDatabase.Database | null, params: DismissParams): void {
  if (!db) return;
  db
    .prepare(
      `INSERT OR REPLACE INTO dismissed_issues (content_hash, issue_index, flag, reason, note, dismissed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.contentHash,
      params.issueIndex,
      params.flag,
      params.reason,
      params.note ?? null,
      Date.now(),
    );
}

type UndismissParams = {
  contentHash: string;
  issueIndex: number;
};

/** Restore a dismissed security issue. Writes to index.db via better-sqlite3. */
export function undismissIssue(db: BetterDatabase.Database | null, params: UndismissParams): void {
  if (!db) return;
  try {
    db
      .prepare(
        "DELETE FROM dismissed_issues WHERE content_hash = ? AND issue_index = ?",
      )
      .run(params.contentHash, params.issueIndex);
  } catch {
    // Table may not exist yet
  }
}

// ── Hash-to-location helper ──────────────────────────────────────

type LocationInfo = {
  file_path: string;
  function_name: string;
  language: string;
  entity_type: string;
  start_line: number;
};

/** Build content_hash → location lookup from file_functions */
function buildHashToLocation(db: BetterDatabase.Database): Map<string, LocationInfo> {
  const map = new Map<string, LocationInfo>();
  try {
    const rows = db.prepare(
      "SELECT file_path, function_name, content_hash, language, entity_type, start_line FROM file_functions",
    ).all() as { file_path: string; function_name: string; content_hash: string; language: string; entity_type: string; start_line: number }[];
    for (const row of rows) {
      const hash = row.content_hash;
      if (!map.has(hash)) {
        map.set(hash, {
          file_path: row.file_path,
          function_name: row.function_name,
          language: row.language || "typescript",
          entity_type: row.entity_type || "function",
          start_line: row.start_line || 0,
        });
      }
    }
  } catch {
    // Table may not exist
  }
  return map;
}

// ── Analysis Map Builder ─────────────────────────────────────────────

/** Build analysis map for a set of content hashes */
function buildAnalysisMapFromDb(
  db: BetterDatabase.Database,
  hashes: Set<string>,
): Map<string, MergedAnalysis> {
  const result = new Map<string, MergedAnalysis>();
  if (hashes.size === 0) return result;

  // Group rows by hash
  const groups = new Map<string, { analysis_type: string; analysis: Record<string, unknown> }[]>();

  try {
    const rows = db.prepare(
      "SELECT content_hash, analysis_type, analysis FROM function_analysis"
    ).all() as { content_hash: string; analysis_type: string; analysis: string }[];
    for (const row of rows) {
      const hash = row.content_hash;
      if (!hashes.has(hash)) continue;

      try {
        const parsed = JSON.parse(row.analysis);
        const existing = groups.get(hash);
        const entry = { analysis_type: row.analysis_type, analysis: parsed };
        if (existing) {
          existing.push(entry);
        } else {
          groups.set(hash, [entry]);
        }
      } catch {
        // Malformed JSON -- skip
      }
    }
  } catch {
    // Table may not exist
  }

  for (const [hash, rows] of groups) {
    result.set(hash, mergeAnalysisRows(rows));
  }

  return result;
}

// ── Practices ────────────────────────────────────────────────────────

export type Practice = {
  practice_id: string;
  rule: string;
  severity: string;
};

/** Get all configured practices */
export function getPractices(db: BetterDatabase.Database): Practice[] {
  if (!tableExists(db, "practices")) return [];

  const practices: Practice[] = [];
  try {
    const rows = db.prepare(
      "SELECT practice_id, rule, severity FROM practices ORDER BY practice_id",
    ).all() as { practice_id: string; rule: string; severity: string }[];
    for (const row of rows) {
      practices.push({
        practice_id: row.practice_id,
        rule: row.rule,
        severity: row.severity ?? "warning",
      });
    }
  } catch {
    // Ignore
  }
  return practices;
}

// ── Architecture Types ──────────────────────────────────────────────

export type CommunitySummary = {
  community_id: string;
  level: number;
  title: string;
  documentation: string;
  meta: {
    securityPosture?: string;
    dataClassification?: string[];
    boundaries?: string[];
    keyFunctions?: string[];
    complexity?: string;
  };
};

export type CrossCuttingConcern = {
  community_id: string;
  title: string;
  concernType: string;
  tag: string;
  documentation: string;
  bridgeFunctions: {
    functionName: string;
    contentHash: string;
    communityId: string;
    centrality: number;
  }[];
  affectedCommunities: {
    communityId: string;
    communityTitle: string;
  }[];
  severity: string;
};

export type ArchitectureHierarchy = {
  l3: CommunitySummary | null;
  groups: {
    groupId: string;
    title: string;
    documentation: string;
    communities: CommunitySummary[];
  }[];
  ungrouped: CommunitySummary[];
  crossCutting: CrossCuttingConcern[];
};

export type CommunityDetail = {
  summary: CommunitySummary;
  members: {
    content_hash: string;
    function_name: string;
    file_path: string;
    description: string;
  }[];
  relatedCommunities: {
    communityId: string;
    title: string;
    weight: number;
    edgeCount: number;
  }[];
  relatedConcerns: CrossCuttingConcern[];
};

export type GroupDetail = {
  summary: CommunitySummary;
  communities: CommunitySummary[];
};

export type ConcernDetail = CrossCuttingConcern & {
  bridgeMembers: {
    content_hash: string;
    function_name: string;
    file_path: string;
    description: string;
  }[];
};

// ── Architecture Queries ────────────────────────────────────────────

/** Parse a community_summaries row's summary JSON */
function parseSummaryRow(row: Record<string, unknown>): CommunitySummary {
  const communityId = row.community_id as string;
  const level = row.level as number;
  let summary: Record<string, unknown> = {};
  try {
    summary = typeof row.summary === "string" ? JSON.parse(row.summary) : (row.summary as Record<string, unknown>) ?? {};
  } catch {
    // Malformed JSON
  }
  return {
    community_id: communityId,
    level,
    title: (summary.title as string) ?? communityId,
    documentation: (summary.documentation as string) ?? "",
    meta: (summary.meta as CommunitySummary["meta"]) ?? {},
  };
}

/** Parse a cross-cutting concern from a community_summaries row */
function parseConcernRow(row: Record<string, unknown>): CrossCuttingConcern {
  const communityId = row.community_id as string;
  let summary: Record<string, unknown> = {};
  try {
    summary = typeof row.summary === "string" ? JSON.parse(row.summary) : (row.summary as Record<string, unknown>) ?? {};
  } catch {
    // Malformed JSON
  }
  return {
    community_id: communityId,
    title: (summary.title as string) ?? communityId,
    concernType: (summary.concernType as string) ?? "security",
    tag: (summary.tag as string) ?? communityId.replace("concern_", ""),
    documentation: (summary.documentation as string) ?? "",
    bridgeFunctions: (summary.bridgeFunctions as CrossCuttingConcern["bridgeFunctions"]) ?? [],
    affectedCommunities: (summary.affectedCommunities as CrossCuttingConcern["affectedCommunities"]) ?? [],
    severity: (summary.severity as string) ?? "medium",
  };
}

/** Get the full architecture hierarchy */
export function getArchitectureHierarchy(db: BetterDatabase.Database): ArchitectureHierarchy | null {
  if (!tableExists(db, "community_summaries")) return null;

  let l3: CommunitySummary | null = null;
  const l2Map = new Map<string, CommunitySummary>();
  const l1List: CommunitySummary[] = [];
  const concerns: CrossCuttingConcern[] = [];

  // Fetch all summaries in one pass
  try {
    const rows = db.prepare(
      "SELECT community_id, level, summary FROM community_summaries ORDER BY level, community_id",
    ).all() as Record<string, unknown>[];
    for (const row of rows) {
      const level = row.level as number;

      if (level === 3) {
        l3 = parseSummaryRow(row);
      } else if (level === 2) {
        l2Map.set(row.community_id as string, parseSummaryRow(row));
      } else if (level === 1) {
        l1List.push(parseSummaryRow(row));
      } else if (level === 10) {
        concerns.push(parseConcernRow(row));
      }
    }
  } catch {
    return null;
  }

  // If no L1 communities found, return null
  if (l1List.length === 0 && !l3) return null;

  // Build L1→L2 mapping from communities table (level=1 maps L1 community → L2 group)
  const l1ToGroup = new Map<string, string>();
  if (tableExists(db, "communities") && l2Map.size > 0) {
    try {
      const rows = db.prepare(
        "SELECT content_hash, community_id FROM communities WHERE level = 1",
      ).all() as { content_hash: string; community_id: string }[];
      for (const row of rows) {
        // At level=1: content_hash is the L1 community_id, community_id is the L2 group
        l1ToGroup.set(row.content_hash, row.community_id);
      }
    } catch {
      // Table may not have level=1 rows
    }
  }

  // Group L1 communities under L2 groups
  const groupMap = new Map<string, CommunitySummary[]>();
  const ungrouped: CommunitySummary[] = [];

  for (const l1 of l1List) {
    const groupId = l1ToGroup.get(l1.community_id);
    if (groupId && l2Map.has(groupId)) {
      const existing = groupMap.get(groupId);
      if (existing) {
        existing.push(l1);
      } else {
        groupMap.set(groupId, [l1]);
      }
    } else {
      ungrouped.push(l1);
    }
  }

  const groups: ArchitectureHierarchy["groups"] = [];
  for (const [groupId, communities] of groupMap) {
    const l2 = l2Map.get(groupId)!;
    groups.push({
      groupId,
      title: l2.title,
      documentation: l2.documentation,
      communities,
    });
  }

  return { l3, groups, ungrouped, crossCutting: concerns };
}

/** Get detail for a single L1 community */
export function getCommunityDetail(db: BetterDatabase.Database, communityId: string): CommunityDetail | null {
  if (!tableExists(db, "community_summaries")) return null;

  // Fetch the L1 summary
  let summary: CommunitySummary | null = null;
  try {
    const row = db.prepare(
      "SELECT community_id, level, summary FROM community_summaries WHERE community_id = ? AND level = 1",
    ).get(communityId) as Record<string, unknown> | undefined;
    if (row) {
      summary = parseSummaryRow(row);
    }
  } catch {
    return null;
  }

  if (!summary) return null;

  // Get member content_hashes (L0 membership)
  const memberHashes: string[] = [];
  if (tableExists(db, "communities")) {
    try {
      const rows = db.prepare(
        "SELECT content_hash FROM communities WHERE community_id = ? AND level = 0",
      ).all(communityId) as { content_hash: string }[];
      for (const row of rows) {
        memberHashes.push(row.content_hash);
      }
    } catch {
      // Ignore
    }
  }

  // Resolve members to function names + file paths + descriptions
  const hashToLocation = buildHashToLocation(db);
  const hashSet = new Set(memberHashes);
  const analysisMap = buildAnalysisMapFromDb(db, hashSet);

  const members = memberHashes
    .map((hash) => {
      const loc = hashToLocation.get(hash);
      if (!loc) return null;
      const analysis = analysisMap.get(hash);
      return {
        content_hash: hash,
        function_name: loc.function_name,
        file_path: loc.file_path,
        description: analysis?.documentation?.description ?? "",
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  // Get related communities via community_edges
  const relatedCommunities: CommunityDetail["relatedCommunities"] = [];
  if (tableExists(db, "community_edges")) {
    // Fetch community titles for related communities
    const titleCache = new Map<string, string>();
    try {
      const titleRows = db.prepare(
        "SELECT community_id, summary FROM community_summaries WHERE level = 1",
      ).all() as { community_id: string; summary: string }[];
      for (const row of titleRows) {
        const id = row.community_id;
        try {
          const s = typeof row.summary === "string" ? JSON.parse(row.summary) : row.summary;
          titleCache.set(id, (s as Record<string, unknown>).title as string ?? id);
        } catch {
          titleCache.set(id, id);
        }
      }
    } catch {
      // Ignore
    }

    try {
      const edgeRows = db.prepare(
        `SELECT source_community, target_community, weight, edge_count
         FROM community_edges
         WHERE source_community = ? OR target_community = ?`,
      ).all(communityId, communityId) as { source_community: string; target_community: string; weight: number; edge_count: number }[];
      for (const row of edgeRows) {
        const otherId = row.source_community === communityId
          ? row.target_community
          : row.source_community;
        if (otherId === communityId) continue;
        relatedCommunities.push({
          communityId: otherId,
          title: titleCache.get(otherId) ?? otherId,
          weight: row.weight ?? 0,
          edgeCount: row.edge_count ?? 0,
        });
      }
    } catch {
      // Ignore
    }
  }

  // Sort related by edge count descending
  relatedCommunities.sort((a, b) => b.edgeCount - a.edgeCount);

  // Get related cross-cutting concerns
  const relatedConcerns: CrossCuttingConcern[] = [];
  try {
    const concernRows = db.prepare(
      "SELECT community_id, level, summary FROM community_summaries WHERE level = 10",
    ).all() as Record<string, unknown>[];
    for (const row of concernRows) {
      const concern = parseConcernRow(row);
      // Check if this concern affects our community
      if (concern.affectedCommunities.some((ac) => ac.communityId === communityId)) {
        relatedConcerns.push(concern);
      }
    }
  } catch {
    // Ignore
  }

  return { summary, members, relatedCommunities, relatedConcerns };
}

/** Get detail for an L2 group */
export function getGroupDetail(db: BetterDatabase.Database, groupId: string): GroupDetail | null {
  if (!tableExists(db, "community_summaries")) return null;

  // Fetch the L2 summary
  let summary: CommunitySummary | null = null;
  try {
    const row = db.prepare(
      "SELECT community_id, level, summary FROM community_summaries WHERE community_id = ? AND level = 2",
    ).get(groupId) as Record<string, unknown> | undefined;
    if (row) {
      summary = parseSummaryRow(row);
    }
  } catch {
    return null;
  }

  if (!summary) return null;

  // Find L1 communities belonging to this group
  const l1Ids: string[] = [];
  if (tableExists(db, "communities")) {
    try {
      const rows = db.prepare(
        "SELECT content_hash FROM communities WHERE community_id = ? AND level = 1",
      ).all(groupId) as { content_hash: string }[];
      for (const row of rows) {
        l1Ids.push(row.content_hash);
      }
    } catch {
      // Ignore
    }
  }

  // Fetch L1 summaries for these communities
  const communities: CommunitySummary[] = [];
  if (l1Ids.length > 0) {
    try {
      const rows = db.prepare(
        "SELECT community_id, level, summary FROM community_summaries WHERE level = 1",
      ).all() as Record<string, unknown>[];
      for (const row of rows) {
        if (l1Ids.includes(row.community_id as string)) {
          communities.push(parseSummaryRow(row));
        }
      }
    } catch {
      // Ignore
    }
  }

  return { summary, communities };
}

/** Get detail for a cross-cutting concern */
export function getConcernDetail(db: BetterDatabase.Database, concernId: string): ConcernDetail | null {
  if (!tableExists(db, "community_summaries")) return null;

  let concern: CrossCuttingConcern | null = null;
  try {
    const row = db.prepare(
      "SELECT community_id, level, summary FROM community_summaries WHERE community_id = ? AND level = 10",
    ).get(concernId) as Record<string, unknown> | undefined;
    if (row) {
      concern = parseConcernRow(row);
    }
  } catch {
    return null;
  }

  if (!concern) return null;

  // Resolve bridge function content hashes to names/paths/descriptions
  const hashToLocation = buildHashToLocation(db);
  const bridgeHashes = new Set(concern.bridgeFunctions.map((b) => b.contentHash));
  const analysisMap = buildAnalysisMapFromDb(db, bridgeHashes);

  const bridgeMembers = concern.bridgeFunctions
    .map((bf) => {
      const loc = hashToLocation.get(bf.contentHash);
      if (!loc) return null;
      const analysis = analysisMap.get(bf.contentHash);
      return {
        content_hash: bf.contentHash,
        function_name: loc.function_name,
        file_path: loc.file_path,
        description: analysis?.documentation?.description ?? "",
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  return { ...concern, bridgeMembers };
}

/** Get all cross-cutting concerns */
export function getConcernsIndex(db: BetterDatabase.Database): CrossCuttingConcern[] {
  if (!tableExists(db, "community_summaries")) return [];

  const concerns: CrossCuttingConcern[] = [];
  try {
    const rows = db.prepare(
      "SELECT community_id, level, summary FROM community_summaries WHERE level = 10 ORDER BY community_id",
    ).all() as Record<string, unknown>[];
    for (const row of rows) {
      concerns.push(parseConcernRow(row));
    }
  } catch {
    // Ignore
  }

  return concerns;
}

// ── Graph Visualizer ─────────────────────────────────────────────────

export type GraphNode = {
  id: string;
  label: string;
  filePath: string;
  communityId: string;
  description: string;
  securityFlags: string[];
  issueCount: number;
};

export type GraphEdge = {
  source: string;
  target: string;
  edgeType: string;
  weight: number;
};

export type GraphCommunity = {
  communityId: string;
  title: string;
  memberCount: number;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: GraphCommunity[];
};

/** Get graph data for the visualizer -- nodes, edges, and community assignments */
export function getGraphData(db: BetterDatabase.Database): GraphData | null {
  if (!tableExists(db, "function_edges")) return null;

  const hashToLocation = buildHashToLocation(db);
  if (hashToLocation.size === 0) return null;

  // Collect all content hashes that participate in edges
  const edgeNodeHashes = new Set<string>();
  const edges: GraphEdge[] = [];

  try {
    const rows = db.prepare(
      "SELECT source_hash, target_hash, edge_type, weight FROM function_edges",
    ).all() as { source_hash: string; target_hash: string; edge_type: string; weight: number }[];
    for (const row of rows) {
      // Only include edges where both nodes have file_functions entries (i.e. still exist in codebase)
      if (!hashToLocation.has(row.source_hash) || !hashToLocation.has(row.target_hash)) continue;
      edgeNodeHashes.add(row.source_hash);
      edgeNodeHashes.add(row.target_hash);
      edges.push({
        source: row.source_hash,
        target: row.target_hash,
        edgeType: row.edge_type,
        weight: row.weight,
      });
    }
  } catch {
    return null;
  }

  if (edgeNodeHashes.size === 0) return null;

  // Build L0 community assignments
  const hashToCommunity = new Map<string, string>();
  if (tableExists(db, "communities")) {
    try {
      const rows = db.prepare(
        "SELECT content_hash, community_id FROM communities WHERE level = 0",
      ).all() as { content_hash: string; community_id: string }[];
      for (const row of rows) {
        hashToCommunity.set(row.content_hash, row.community_id);
      }
    } catch {
      // Ignore -- communities may not exist yet
    }
  }

  // Build analysis map for security info
  const analysisMap = buildAnalysisMapFromDb(db, edgeNodeHashes);

  // Build nodes
  const nodes: GraphNode[] = [];
  for (const hash of edgeNodeHashes) {
    const loc = hashToLocation.get(hash)!;
    const analysis = analysisMap.get(hash);
    nodes.push({
      id: hash,
      label: loc.function_name,
      filePath: loc.file_path,
      communityId: hashToCommunity.get(hash) ?? "",
      description: analysis?.documentation?.description ?? "",
      securityFlags: analysis?.security?.securityFlags ?? [],
      issueCount: analysis?.security?.issues?.length ?? 0,
    });
  }

  // Build community summaries (only for communities that have members in the graph)
  const activeCommunityIds = new Set(
    nodes.map((n) => n.communityId).filter(Boolean),
  );
  const communities: GraphCommunity[] = [];

  if (activeCommunityIds.size > 0 && tableExists(db, "community_summaries")) {
    // Count members per community
    const memberCounts = new Map<string, number>();
    for (const node of nodes) {
      if (node.communityId) {
        memberCounts.set(node.communityId, (memberCounts.get(node.communityId) ?? 0) + 1);
      }
    }

    try {
      const rows = db.prepare(
        "SELECT community_id, summary FROM community_summaries WHERE level = 1",
      ).all() as { community_id: string; summary: string }[];
      for (const row of rows) {
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
    } catch {
      // Ignore
    }
  }

  return { nodes, edges, communities };
}
