import type { DocumentationAnalysis, SecurityAnalysis, PracticesAnalysis } from '@ophan/core/schemas'

/** Nested analysis shape -- provenance is clear, extensible for future types */
export type MergedAnalysis = {
  documentation: DocumentationAnalysis
  security: SecurityAnalysis
  practices: PracticesAnalysis
}

/** Location + merged analysis -- the primary composable data unit */
export type EnrichedFunction = {
  file_path: string
  function_name: string
  content_hash: string
  language: string
  entity_type: string
  start_line: number
  analysis: MergedAnalysis
}

/** A single issue extracted from a function's security analysis */
export type FlatIssue = {
  fn: EnrichedFunction
  issue: EnrichedFunction['analysis']['security']['issues'][number]
  issueIndex: number
}
