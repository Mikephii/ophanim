import { SECURITY_FLAG_META } from '@ophan/core/schemas'
import type { EnrichedFunction } from '@/services/api/types'

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
  return (SECURITY_FLAG_META[flag]?.tier ?? 3) as 1 | 2 | 3 | 4
}

/** A single issue extracted from a function's security analysis */
export type FlatIssue = {
  fn: EnrichedFunction
  issue: EnrichedFunction['analysis']['security']['issues'][number]
  issueIndex: number
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
