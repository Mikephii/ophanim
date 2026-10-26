import type { DetailedIssue, FunctionData } from "./types";

export interface ResolvedRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
  anchorFound: boolean; // false when issue's code was modified -- suppress squiggle
}

/**
 * Maps a DetailedIssue to a character range within a file.
 *
 * Resolution strategy:
 * 1. Compute file line: functionStartLine + issue.line - 2 (both 1-indexed → 0-indexed)
 * 2. Find startText on that line via indexOf() → character start
 * 3. If not found, search nearby lines within the function (handles stale line offsets
 *    when the TS language server hasn't updated symbol positions yet after an edit)
 * 4. Find endText after startText → character end
 * 5. Fallback: anchors not found anywhere → full-line highlight on function declaration
 *
 * @param getLineText - callback that returns the text of a 0-indexed line (enables testing without VS Code)
 */
export function resolveIssueRange(
  issue: DetailedIssue,
  functionStartLine: number,
  functionEndLine: number,
  getLineText: (zeroIndexedLine: number) => string,
  totalLineCount: number,
): ResolvedRange {
  const fnStart0 = functionStartLine - 1;
  const fnEnd0 = functionEndLine - 1;

  // Compute target line (0-indexed)
  let targetLine0 = fnStart0 + issue.line - 1;

  // Bounds check: if line is missing, zero, or out of range, fall back to function declaration
  if (issue.line <= 0 || targetLine0 < 0 || targetLine0 >= totalLineCount || targetLine0 > fnEnd0) {
    targetLine0 = fnStart0;
  }

  let lineText = getLineText(targetLine0);

  let startChar = 0;
  let endChar = lineText.length;

  let anchorFound = true;

  if (issue.startText) {
    let startIdx = lineText.indexOf(issue.startText);

    // If not found on computed target line, search nearby lines within function bounds.
    // This handles stale line offsets when symbol positions lag behind edits (e.g. user
    // inserts a newline above the function and the TS server hasn't updated yet).
    if (startIdx === -1) {
      const maxOffset = Math.max(fnEnd0 - fnStart0, 0);
      for (let offset = 1; offset <= maxOffset; offset++) {
        for (const delta of [-offset, offset]) {
          const candidate = targetLine0 + delta;
          if (candidate < fnStart0 || candidate > fnEnd0 || candidate < 0 || candidate >= totalLineCount) continue;
          const candidateText = getLineText(candidate);
          const idx = candidateText.indexOf(issue.startText);
          if (idx !== -1) {
            targetLine0 = candidate;
            lineText = candidateText;
            startIdx = idx;
            break;
          }
        }
        if (startIdx !== -1) break;
      }
    }

    // Recalculate endChar for the (possibly updated) line
    endChar = lineText.length;

    if (startIdx !== -1) {
      startChar = startIdx;

      if (issue.endText) {
        // Search for endText after startText
        const searchFrom = startIdx + issue.startText.length;
        const endIdx = lineText.indexOf(issue.endText, searchFrom);
        if (endIdx !== -1) {
          endChar = endIdx + issue.endText.length;
        } else {
          // Try from startText position (endText may overlap)
          const endIdx2 = lineText.indexOf(issue.endText, startIdx);
          if (endIdx2 !== -1) {
            endChar = endIdx2 + issue.endText.length;
          }
          // Otherwise keep endChar = lineText.length (to end of line)
        }
      } else {
        // No endText -- highlight just the startText span
        endChar = startIdx + issue.startText.length;
      }
    } else {
      // startText not found anywhere in function -- code was removed/rewritten
      anchorFound = false;
    }
  }

  // Modification detection: if lineText is stored (new analysis), compare with current line.
  // If the line text changed, the issue's code was edited -- suppress the squiggle.
  // This catches cases anchors miss: commenting out, changing args, same-call-different-args.
  // See docs/architecture/extension-lifecycle.md (Remediation Detection) for the edge cases.
  if (issue.lineText && anchorFound) {
    const currentLineText = lineText.trim();
    if (currentLineText !== issue.lineText) {
      anchorFound = false;
    }
  }

  return { startLine: targetLine0, startChar, endLine: targetLine0, endChar, anchorFound };
}

/**
 * Finds the FunctionData whose line range contains the given 0-indexed line.
 * Used by the CodeActionProvider to map a diagnostic back to its function.
 */
export function findFunctionForLine(
  functions: FunctionData[],
  line0: number,
): FunctionData | undefined {
  return functions.find(
    (f) =>
      f.startLine > 0 &&
      f.endLine > 0 &&
      line0 >= f.startLine - 1 &&
      line0 <= f.endLine - 1
  );
}

/**
 * Maps DetailedIssue severity to numeric DiagnosticSeverity values.
 * 0 = Error, 1 = Warning, 2 = Information (matches vscode.DiagnosticSeverity)
 */
export function mapSeverity(severity: string): number {
  switch (severity) {
    case "error": return 0;
    case "warning": return 1;
    case "info": return 2;
    default: return 1;
  }
}

/**
 * Builds the diagnostic message for the Problems panel and squiggly hover.
 */
export function buildDiagnosticMessage(issue: DetailedIssue): string {
  if (issue.title && issue.description) {
    return `${issue.title}: ${issue.description}`;
  }
  return issue.title || issue.flag;
}

// ============ Debounced Re-Resolution ============

/**
 * A symbol position from the document symbol provider, abstracted
 * to avoid VS Code types in the pure function.
 */
export interface SymbolPosition {
  name: string;
  startLine: number; // 0-indexed
  endLine: number;   // 0-indexed
}

/**
 * A resolved diagnostic ready for emission -- pure data, no VS Code types.
 */
export interface ResolvedDiagnostic {
  range: ResolvedRange;
  message: string;
  severity: number;    // 0=Error, 1=Warning, 2=Info (matches vscode.DiagnosticSeverity)
  source: "Ophan";
  flag: string;
  contentHash: string; // for command link back to showFunction
  anchorFound: boolean; // false when issue's code was modified -- caller should skip emission
}

/**
 * Per-issue edit state: tracks adjusted line positions and remediation detection
 * during editing (before re-analysis completes). Stored in index.db so the
 * webview can show accurate line numbers and "potentially fixed" badges.
 */
export interface IssueEditState {
  contentHash: string;
  issueType: "security" | "practice";
  issueIndex: number;
  adjustedLine: number;           // 0-indexed file-absolute line
  potentiallyRemediated: boolean; // true when lineText changed (anchorFound = false)
}

/**
 * Re-resolves diagnostics for a file using fresh symbol positions and current document text.
 *
 * Used during editing to keep diagnostics at correct positions without waiting for
 * a full re-analysis cycle. The caller provides fresh function line numbers from the
 * document symbol provider and current document text; this function matches them to
 * cached analysis data and re-runs anchor-based resolution.
 *
 * Matching: groups cached functions and fresh symbols by name, then zips positionally
 * within each name group (mirrors provideCodeLenses disambiguation for duplicate names).
 */
export function reResolveFileDiagnostics(
  cachedFunctions: FunctionData[],
  freshSymbols: SymbolPosition[],
  getLineText: (zeroIndexedLine: number) => string,
  totalLineCount: number,
): {
  diagnostics: ResolvedDiagnostic[];
  gutterLines: number[];
  issueEditStates: IssueEditState[];
} {
  const diagnostics: ResolvedDiagnostic[] = [];
  const gutterLineSet = new Set<number>();
  const issueEditStates: IssueEditState[] = [];

  // Group cached functions by name (preserving order)
  const cachedByName = new Map<string, FunctionData[]>();
  for (const fn of cachedFunctions) {
    const list = cachedByName.get(fn.name) || [];
    list.push(fn);
    cachedByName.set(fn.name, list);
  }

  // Group fresh symbols by name (preserving order)
  const symbolsByName = new Map<string, SymbolPosition[]>();
  for (const sym of freshSymbols) {
    const list = symbolsByName.get(sym.name) || [];
    list.push(sym);
    symbolsByName.set(sym.name, list);
  }

  // Match by name + positional index
  for (const [name, cachedList] of cachedByName) {
    const symList = symbolsByName.get(name);
    if (!symList) continue;

    const matchCount = Math.min(cachedList.length, symList.length);
    for (let i = 0; i < matchCount; i++) {
      const fn = cachedList[i];
      const sym = symList[i];

      // Fresh 1-indexed boundaries (resolveIssueRange expects 1-indexed)
      const freshStartLine = sym.startLine + 1;
      const freshEndLine = sym.endLine + 1;

      // Track security issues and practice violations with separate index counters
      // so edit state keys match the issueIndex used by dismissed_issues.
      const securityIssues = fn.issues;
      const practiceViolations = fn.practiceViolations || [];

      for (let si = 0; si < securityIssues.length; si++) {
        const issue = securityIssues[si];
        if (!issue.title && !issue.flag) continue;

        const resolved = resolveIssueRange(
          issue, freshStartLine, freshEndLine, getLineText, totalLineCount,
        );

        // Record edit state for ALL issues (including suppressed ones)
        issueEditStates.push({
          contentHash: fn.contentHash,
          issueType: "security",
          issueIndex: si,
          adjustedLine: resolved.startLine,
          potentiallyRemediated: !resolved.anchorFound,
        });

        // Skip diagnostics where the issue's code was modified (anchorFound = false).
        // The squiggle would be misleading -- suppress until re-analysis confirms.
        if (!resolved.anchorFound) continue;

        diagnostics.push({
          range: resolved,
          message: buildDiagnosticMessage(issue),
          severity: mapSeverity(issue.severity),
          source: "Ophan",
          flag: issue.flag,
          contentHash: fn.contentHash,
          anchorFound: resolved.anchorFound,
        });

        gutterLineSet.add(resolved.startLine);
      }

      for (let pi = 0; pi < practiceViolations.length; pi++) {
        const issue = practiceViolations[pi];
        if (!issue.title && !issue.flag) continue;

        const resolved = resolveIssueRange(
          issue, freshStartLine, freshEndLine, getLineText, totalLineCount,
        );

        issueEditStates.push({
          contentHash: fn.contentHash,
          issueType: "practice",
          issueIndex: pi,
          adjustedLine: resolved.startLine,
          potentiallyRemediated: !resolved.anchorFound,
        });

        if (!resolved.anchorFound) continue;

        diagnostics.push({
          range: resolved,
          message: buildDiagnosticMessage(issue),
          severity: mapSeverity(issue.severity),
          source: "Ophan",
          flag: issue.flag,
          contentHash: fn.contentHash,
          anchorFound: resolved.anchorFound,
        });

        gutterLineSet.add(resolved.startLine);
      }
    }
  }

  return {
    diagnostics: deduplicateDiagnostics(diagnostics),
    gutterLines: [...gutterLineSet].sort((a, b) => a - b),
    issueEditStates,
  };
}

/**
 * Removes duplicate diagnostics with the same (line, flag) pair.
 * Claude sometimes returns near-duplicate issues (same flag, same line,
 * slightly different wording). Keep only the first occurrence.
 */
export function deduplicateDiagnostics(diagnostics: ResolvedDiagnostic[]): ResolvedDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.range.startLine}:${d.flag}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
