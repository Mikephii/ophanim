import type BetterDatabase from "better-sqlite3";
import type { FunctionAnalysis, FunctionData, DbEntry } from "./types";

export function queryFileAnalysis(db: BetterDatabase.Database, filePath: string): DbEntry[] {
  // Query returns up to 3 rows per function (documentation + security + practices) -- merge them
  const grouped = new Map<string, { functionName: string; contentHash: string; doc: any; sec: any; prac: any; language: string; entityType: string }>();

  try {
    const rows = db.prepare(
      `SELECT ff.function_name, ff.content_hash, fa.analysis_type, fa.analysis, ff.language, ff.entity_type
       FROM file_functions ff
       JOIN function_analysis fa ON ff.content_hash = fa.content_hash
       WHERE ff.file_path = ?`
    ).all(filePath) as { function_name: string; content_hash: string; analysis_type: string; analysis: string; language: string; entity_type: string }[];

    for (const row of rows) {
      const parsed = JSON.parse(row.analysis);

      let entry = grouped.get(row.content_hash);
      if (!entry) {
        entry = {
          functionName: row.function_name,
          contentHash: row.content_hash,
          doc: {},
          sec: {},
          prac: {},
          language: row.language || "typescript",
          entityType: row.entity_type || "function",
        };
        grouped.set(row.content_hash, entry);
      }

      if (row.analysis_type === "documentation") entry.doc = parsed;
      else if (row.analysis_type === "security") entry.sec = parsed;
      else if (row.analysis_type === "practices") entry.prac = parsed;
    }
  } catch {
    // Table may not exist
  }

  return [...grouped.values()].map((entry) => ({
    functionName: entry.functionName,
    contentHash: entry.contentHash,
    analysis: {
      description: entry.doc.description || "",
      params: entry.doc.params || [],
      returns: entry.doc.returns || { type: "unknown", description: "" },
      dataTags: entry.sec.dataTags || [],
      securityFlags: entry.sec.securityFlags || [],
      issues: entry.sec.issues || [],
      practiceViolations: entry.prac.violations || [],
    },
    language: entry.language,
    entityType: entry.entityType,
  }));
}

export function queryAllAnalysis(db: BetterDatabase.Database): Map<string, FunctionData[]> {
  // Query returns up to 3 rows per function (documentation + security + practices) -- group and merge
  const grouped = new Map<string, { filePath: string; functionName: string; contentHash: string; doc: any; sec: any; prac: any; language: string; entityType: string }>();

  try {
    const rows = db.prepare(
      `SELECT ff.file_path, ff.function_name, ff.content_hash, fa.analysis_type, fa.analysis, ff.language, ff.entity_type
       FROM file_functions ff
       JOIN function_analysis fa ON ff.content_hash = fa.content_hash
       ORDER BY ff.file_path, ff.function_name`
    ).all() as { file_path: string; function_name: string; content_hash: string; analysis_type: string; analysis: string; language: string; entity_type: string }[];

    for (const row of rows) {
      const parsed = JSON.parse(row.analysis);

      let entry = grouped.get(row.content_hash);
      if (!entry) {
        entry = {
          filePath: row.file_path,
          functionName: row.function_name,
          contentHash: row.content_hash,
          doc: {},
          sec: {},
          prac: {},
          language: row.language || "typescript",
          entityType: row.entity_type || "function",
        };
        grouped.set(row.content_hash, entry);
      }

      if (row.analysis_type === "documentation") entry.doc = parsed;
      else if (row.analysis_type === "security") entry.sec = parsed;
      else if (row.analysis_type === "practices") entry.prac = parsed;
    }
  } catch {
    // Table may not exist
  }

  const byFile = new Map<string, FunctionData[]>();
  for (const entry of grouped.values()) {
    const fn: FunctionData = {
      name: entry.functionName,
      filePath: entry.filePath,
      startLine: 0,
      endLine: 0,
      contentHash: entry.contentHash,
      description: entry.doc.description || "",
      params: entry.doc.params || [],
      returns: entry.doc.returns || { type: "unknown", description: "" },
      dataTags: entry.sec.dataTags || [],
      securityFlags: entry.sec.securityFlags || [],
      issues: entry.sec.issues || [],
      practiceViolations: entry.prac.violations || [],
      language: entry.language,
      entityType: entry.entityType,
    };

    const existing = byFile.get(entry.filePath) || [];
    existing.push(fn);
    byFile.set(entry.filePath, existing);
  }

  return byFile;
}

export function queryCommunityTitle(
  db: BetterDatabase.Database,
  contentHash: string,
): string | null {
  try {
    // Check if graph tables exist
    const hasTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='communities'",
    ).get();
    if (!hasTable) return null;

    // Look up L0 community membership
    const membership = db.prepare(
      `SELECT community_id FROM communities
       WHERE content_hash = ? AND level = 0
       LIMIT 1`,
    ).get(contentHash) as { community_id: string } | undefined;
    if (!membership) return null;

    // Check if community_summaries table exists
    const hasSumTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='community_summaries'",
    ).get();
    if (!hasSumTable) return null;

    // Look up L1 summary title for this community
    const summaryRow = db.prepare(
      `SELECT summary FROM community_summaries
       WHERE community_id = ? AND level = 1
       LIMIT 1`,
    ).get(membership.community_id) as { summary: string } | undefined;
    if (!summaryRow) return null;

    const parsed = JSON.parse(summaryRow.summary);
    return parsed.title || null;
  } catch {
    return null;
  }
}

export function entryToFunctionData(
  entry: DbEntry,
  filePath: string,
  startLine: number,
  endLine: number
): FunctionData {
  return {
    name: entry.functionName,
    filePath,
    startLine,
    endLine,
    contentHash: entry.contentHash,
    ...entry.analysis,
    language: entry.language,
    entityType: entry.entityType,
  };
}
