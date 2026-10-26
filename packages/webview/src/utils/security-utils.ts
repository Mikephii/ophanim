import type { EnrichedFunction, FlatIssue } from './types'

/** Tier lookup for known security flags (copied from @ophan/core/schemas) */
const FLAG_TIERS: Record<string, 1 | 2 | 3 | 4> = {
  sql_injection: 1,
  command_injection: 1,
  hardcoded_secret: 1,
  eval_exec: 2,
  path_traversal: 2,
  insecure_subprocess: 2,
  unsanitized_input: 3,
  xss: 3,
  pickle_deserialization: 3,
  prototype_pollution: 4,
}

/** Numeric score for severity: error=3, warning=2, info=1 */
export function severityScore(severity: string): number {
  return severity === 'error' ? 3 : severity === 'warning' ? 2 : 1
}

/** Numeric score for confidence: high=3, medium=2, low=1 */
export function confidenceScore(confidence: string): number {
  return confidence === 'high' ? 3 : confidence === 'medium' ? 2 : 1
}

/**
 * Combined priority score for sorting issues.
 * Higher = more urgent. Range: 4 (info+low) to 12 (error+high).
 */
export function priorityScore(severity: string, confidence: string): number {
  return severityScore(severity) * 3 + confidenceScore(confidence)
}

/** Human-readable priority label from score */
export function priorityLabel(score: number): string {
  if (score >= 12) return 'P0'
  if (score >= 9) return 'P1'
  if (score >= 6) return 'P2'
  return 'P3'
}

/** Get the tier for a security flag, defaulting to 3 for unknown flags */
export function flagTier(flag: string): 1 | 2 | 3 | 4 {
  return FLAG_TIERS[flag] ?? 3
}

/** Flatten functions into individual issues, sorted by priority (highest first) */
export function flattenIssues(
  functions: EnrichedFunction[],
  flagFilter?: string,
): FlatIssue[] {
  const flat: FlatIssue[] = []
  for (const fn of functions) {
    const issues = fn.analysis.security.issues ?? []
    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i]
      if (flagFilter && issue.flag !== flagFilter) continue
      flat.push({ fn, issue, issueIndex: i })
    }
  }
  flat.sort(
    (a, b) =>
      priorityScore(b.issue.severity, b.issue.confidence) -
      priorityScore(a.issue.severity, a.issue.confidence),
  )
  return flat
}
