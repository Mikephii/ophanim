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

/** Generic pagination wrapper */
export type PaginatedResult<T> = {
  data: T[]
  total: number
  page: number
  pageSize: number
}

/** Composable filters for function queries */
export type FunctionFilters = {
  language?: string
  search?: string
  securityOnly?: boolean
}

/** Pagination parameters */
export type PaginationParams = {
  page?: number
  pageSize?: number
}

/** Security-specific filters */
export type SecurityFilters = {
  flag?: string
  dataTag?: string
  /** Filter to issues containing at least one issue with this severity */
  severity?: string
}

/** Repo summary for list views (includes computed counts) */
export type RepoSummary = {
  id: string
  name: string
  remote_url: string | null
  created_at: string
  updated_at: string
  functionCount: number
  securityIssueCount: number
}

/** Repo metadata (no computed counts) */
export type Repo = {
  id: string
  name: string
  remote_url: string | null
  docs_branch: string
  last_docs_sync_commit: string | null
  last_docs_sync_at: string | null
  created_at: string
  updated_at: string
}

/** A single docs sync history entry */
export type DocsSyncHistoryEntry = {
  id: string
  commit_hash: string
  branch: string
  synced_at: string
}

/** Dashboard-level aggregate stats */
export type DashboardStats = {
  repoCount: number
  functionCount: number
  securityIssueCount: number
}

/** Per-repo stats */
export type RepoStats = {
  functionCount: number
  securityIssueCount: number
  languages: string[]
}

/** Security flag breakdown -- count per flag type */
export type SecurityBreakdown = Record<string, number>

/** Per-flag breakdown with severity detail */
export type FlagBreakdownEntry = {
  count: number
  errorCount: number
  warningCount: number
  infoCount: number
}

/** Security dashboard aggregate stats */
export type SecurityDashboardStats = {
  posture: 'critical' | 'warning' | 'clean'
  /** Issues with severity=error AND confidence=high (P0 -- clearly exploitable) */
  criticalCount: number
  /** All severity=error issues (regardless of confidence) */
  errorCount: number
  warningCount: number
  infoCount: number
  totalFunctions: number
  breakdown: Record<string, FlagBreakdownEntry>
}

/** Community summary from Supabase */
export type CommunitySummary = {
  community_id: string
  level: number
  algorithm: string
  input_hash: string
  summary: {
    title: string
    documentation: string
    meta: {
      securityPosture: string
      dataClassification: string[]
      boundaries: string[]
      keyFunctions: string[]
      complexity: 'low' | 'medium' | 'high'
    }
  }
  model_version: string | null
}

/** Cross-cutting concern summary from Supabase (level=10) */
export type CrossCuttingConcern = {
  community_id: string
  level: number
  algorithm: string
  input_hash: string
  summary: {
    title: string
    concernType: string
    tag: string
    documentation: string
    bridgeFunctions: {
      functionName: string
      contentHash: string
      communityId: string
      centrality: number
    }[]
    affectedCommunities: {
      communityId: string
      communityTitle: string
    }[]
    severity: string
  }
  model_version: string | null
}

/** Related community via community edges */
export type RelatedCommunity = {
  communityId: string
  title: string
  weight: number
  edgeCount: number
}

/** L1 group -- a cluster of related L0 communities from hierarchical detection */
export type L1Group = {
  groupId: string
  title: string
  l1Communities: CommunitySummary[]
  /** Full L2 documentation for this group (parent page content) */
  overview?: CommunitySummary
}

/** Architecture hierarchy for overview page */
export type ArchitectureHierarchy = {
  l3: CommunitySummary | null
  l2: CommunitySummary[]
  l1: CommunitySummary[]
  crossCutting: CrossCuttingConcern[]
  groups: L1Group[]
}

/** L1 summary enriched with member function data */
/** Reason for dismissing a security issue */
export type DismissReason = 'false_positive' | 'accepted_risk' | 'wont_fix'

/** A dismissed security issue record */
export type DismissedIssue = {
  content_hash: string
  issue_index: number
  flag: string
  reason: DismissReason
  note: string | null
  dismissed_at: string
}

/** Display labels for dismiss reasons */
export const DISMISS_REASON_LABELS: Record<DismissReason, string> = {
  false_positive: 'False Positive',
  accepted_risk: 'Accepted Risk',
  wont_fix: "Won't Fix",
}

export type EnrichedL1Summary = CommunitySummary & {
  memberCount: number
  members: {
    content_hash: string
    function_name: string
    file_path: string
    description: string
  }[]
  relatedCommunities: RelatedCommunity[]
  relatedConcerns: CrossCuttingConcern[]
  parentGroup: { groupId: string; title: string } | null
}
