import type Database from "better-sqlite3";
import { MAX_PRACTICES, MAX_RULE_LENGTH } from "./schemas";

export interface Practice {
  id: string;
  rule: string;
  severity: "error" | "warning" | "info";
}

export { MAX_PRACTICES, MAX_RULE_LENGTH };

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Load practices from the local SQLite practices table.
 * Returns [] if table is empty or doesn't exist.
 */
export function loadPracticesFromDb(db: Database.Database): Practice[] {
  try {
    const rows = db
      .prepare("SELECT practice_id, rule, severity FROM practices")
      .all() as { practice_id: string; rule: string; severity: string }[];
    return rows.map((r) => ({
      id: r.practice_id,
      rule: r.rule,
      severity: r.severity as Practice["severity"],
    }));
  } catch {
    // Table doesn't exist yet (old DB without initDb migration)
    return [];
  }
}

/**
 * Import practices from Supabase into the local SQLite practices table.
 * Replaces all existing practices (full sync).
 */
export function importPractices(
  db: Database.Database,
  practices: Practice[]
): void {
  const validated = validatePractices(practices);
  db.transaction(() => {
    db.prepare("DELETE FROM practices").run();
    const insert = db.prepare(
      "INSERT INTO practices (practice_id, rule, severity) VALUES (?, ?, ?)"
    );
    for (const p of validated) {
      insert.run(p.id, p.rule, p.severity);
    }
  })();
}

/**
 * Validate practices array. Enforces limits and format.
 * Returns the validated (possibly truncated) array.
 */
export function validatePractices(practices: Practice[]): Practice[] {
  if (!Array.isArray(practices)) return [];

  const capped = practices.slice(0, MAX_PRACTICES);

  return capped.map((p, i) => {
    if (!p.id || typeof p.id !== "string") {
      throw new Error(`Practice at index ${i} has invalid id: ${JSON.stringify(p.id)}`);
    }
    if (!ID_PATTERN.test(p.id)) {
      throw new Error(`Practice id "${p.id}" must be kebab-case (lowercase letters, numbers, hyphens)`);
    }
    if (!p.rule || typeof p.rule !== "string") {
      throw new Error(`Practice "${p.id}" has invalid rule`);
    }

    const severity = p.severity ?? "warning";
    if (!["error", "warning", "info"].includes(severity)) {
      throw new Error(`Practice "${p.id}" has invalid severity: ${severity}`);
    }

    return {
      id: p.id,
      rule: p.rule.slice(0, MAX_RULE_LENGTH),
      severity: severity as Practice["severity"],
    };
  });
}

/**
 * Build the prompt section for practices. Returns empty string if no practices.
 */
export function buildPracticesPrompt(practices: Practice[]): string {
  if (practices.length === 0) return "";

  const lines = practices.map(
    (p) => `- ${p.id} [${p.severity}]: ${p.rule}`
  );

  return `
Also check for violations of these coding practices:
${lines.join("\n")}

For each violation found, add an entry to practiceViolations (empty array if none), each with:
  - flag: the practice id from the list above
  - title: short one-line title
  - description: what's wrong (1-2 sentences)
  - explanation: how to fix (2-4 sentences)
  - line: the line number (read the label, don't count)
  - startText: first ~30 characters of the problematic code on that line
  - endText: last ~20 characters of the problematic code on that line
  - severity: use the severity shown in brackets above`;
}
