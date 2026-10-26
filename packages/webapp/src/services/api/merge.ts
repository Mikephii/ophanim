import type { DocumentationAnalysis, SecurityAnalysis, PracticesAnalysis } from '@ophan/core/schemas'
import type { MergedAnalysis } from './types'

const EMPTY_DOC: DocumentationAnalysis = {
  description: '',
  params: [],
  returns: { type: 'unknown', description: '' },
}

const EMPTY_SEC: SecurityAnalysis = {
  dataTags: [],
  securityFlags: [],
  issues: [],
}

const EMPTY_PRAC: PracticesAnalysis = {
  violations: [],
}

type AnalysisRow = {
  content_hash: string
  analysis_type: string
  analysis: Record<string, unknown>
}

/**
 * Merge an array of analysis rows (doc + sec) for a single content_hash
 * into a unified MergedAnalysis shape.
 */
export function mergeAnalysisRows(
  rows: Pick<AnalysisRow, 'analysis_type' | 'analysis'>[],
): MergedAnalysis {
  let doc: DocumentationAnalysis = EMPTY_DOC
  let sec: SecurityAnalysis = EMPTY_SEC
  let prac: PracticesAnalysis = EMPTY_PRAC

  for (const row of rows) {
    const a = (row.analysis ?? {}) as Record<string, unknown>
    if (row.analysis_type === 'documentation') {
      doc = {
        description: (a.description as string) ?? '',
        params: (a.params as DocumentationAnalysis['params']) ?? [],
        returns: (a.returns as DocumentationAnalysis['returns']) ?? {
          type: 'unknown',
          description: '',
        },
      }
    } else if (row.analysis_type === 'security') {
      sec = {
        dataTags: (a.dataTags as string[]) ?? [],
        securityFlags: (a.securityFlags as string[]) ?? [],
        issues: (a.issues as SecurityAnalysis['issues']) ?? [],
      }
    } else if (row.analysis_type === 'practices') {
      prac = {
        violations: (a.violations as PracticesAnalysis['violations']) ?? [],
      }
    }
  }

  return { documentation: doc, security: sec, practices: prac }
}

/**
 * Batch merge: group rows by content_hash, merge each group.
 * Returns a Map for O(1) lookup when hydrating locations.
 */
export function buildAnalysisMap(
  rows: AnalysisRow[],
): Map<string, MergedAnalysis> {
  const groups = new Map<
    string,
    Pick<AnalysisRow, 'analysis_type' | 'analysis'>[]
  >()

  for (const row of rows) {
    const existing = groups.get(row.content_hash)
    if (existing) {
      existing.push(row)
    } else {
      groups.set(row.content_hash, [row])
    }
  }

  const result = new Map<string, MergedAnalysis>()
  for (const [hash, group] of groups) {
    result.set(hash, mergeAnalysisRows(group))
  }

  return result
}
