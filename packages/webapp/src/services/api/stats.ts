import { createServerFn } from '@tanstack/react-start'
import type { DashboardStats, RepoStats, SecurityBreakdown, SecurityDashboardStats, FlagBreakdownEntry } from './types'

export const getDashboardStats = createServerFn().handler(
  async ({ context }): Promise<DashboardStats> => {
    const { SBServerClient: supabase } = context as any

    const [repoRes, fnRes, secRes] = await Promise.all([
      supabase.from('repos').select('id', { count: 'exact', head: true }),
      supabase
        .from('function_locations')
        .select('repo_id', { count: 'exact', head: true }),
      supabase
        .from('function_analysis')
        .select('content_hash', { count: 'exact', head: true })
        .eq('analysis_type', 'security')
        .eq('has_security_flags', true),
    ])

    return {
      repoCount: repoRes.count ?? 0,
      functionCount: fnRes.count ?? 0,
      securityIssueCount: secRes.count ?? 0,
    }
  },
)

export const getRepoStats = createServerFn({ method: 'GET' })
  .inputValidator((data: { repoId: string }) => data)
  .handler(async ({ data, context }): Promise<RepoStats> => {
    const { SBServerClient: supabase } = context as any

    const [fnRes, secRes, langRes] = await Promise.all([
      supabase
        .from('function_locations')
        .select('repo_id', { count: 'exact', head: true })
        .eq('repo_id', data.repoId),
      supabase
        .from('function_analysis')
        .select('content_hash', { count: 'exact', head: true })
        .eq('repo_id', data.repoId)
        .eq('analysis_type', 'security')
        .eq('has_security_flags', true),
      supabase
        .from('function_locations')
        .select('language')
        .eq('repo_id', data.repoId),
    ])

    const languages = [
      ...new Set((langRes.data ?? []).map((r: any) => r.language)),
    ] as string[]

    return {
      functionCount: fnRes.count ?? 0,
      securityIssueCount: secRes.count ?? 0,
      languages,
    }
  })

export const getSecurityBreakdown = createServerFn({ method: 'GET' })
  .inputValidator((data: { repoId: string }) => data)
  .handler(async ({ data, context }): Promise<SecurityBreakdown> => {
    const { SBServerClient: supabase } = context as any

    const { data: rows } = await supabase
      .from('function_analysis')
      .select('analysis')
      .eq('repo_id', data.repoId)
      .eq('analysis_type', 'security')
      .eq('has_security_flags', true)

    const breakdown: SecurityBreakdown = {}
    for (const row of rows ?? []) {
      const flags = (row.analysis as any)?.securityFlags ?? []
      for (const flag of flags) {
        breakdown[flag] = (breakdown[flag] || 0) + 1
      }
    }

    return breakdown
  })

/**
 * Security dashboard stats: posture indicator, severity counts, per-flag breakdown.
 * Iterates actual DetailedIssue entries (not just flag arrays) for accurate severity counts.
 */
export const getSecurityDashboardStats = createServerFn({ method: 'GET' })
  .inputValidator((data: { repoId: string }) => data)
  .handler(async ({ data, context }): Promise<SecurityDashboardStats> => {
    const { SBServerClient: supabase } = context as any

    const [secRes, fnRes, dismissedRes] = await Promise.all([
      supabase
        .from('function_analysis')
        .select('content_hash, analysis')
        .eq('repo_id', data.repoId)
        .eq('analysis_type', 'security')
        .eq('has_security_flags', true),
      supabase
        .from('function_locations')
        .select('repo_id', { count: 'exact', head: true })
        .eq('repo_id', data.repoId),
      supabase
        .from('dismissed_issues')
        .select('content_hash, issue_index')
        .eq('repo_id', data.repoId),
    ])

    // Build set of dismissed (content_hash:issue_index) for O(1) lookups
    const dismissedSet = new Set(
      (dismissedRes.data ?? []).map((d: any) => `${d.content_hash}:${d.issue_index}`),
    )

    let criticalCount = 0  // severity=error AND confidence=high (P0)
    let errorCount = 0     // all severity=error
    let warningCount = 0
    let infoCount = 0
    const breakdown: Record<string, FlagBreakdownEntry> = {}

    for (const row of secRes.data ?? []) {
      const analysis = row.analysis as any
      const contentHash = row.content_hash as string
      const issues = analysis?.issues ?? []

      for (let i = 0; i < issues.length; i++) {
        // Skip dismissed issues
        if (dismissedSet.has(`${contentHash}:${i}`)) continue

        const issue = issues[i]
        const severity = issue.severity ?? 'warning'
        const confidence = issue.confidence ?? 'medium'
        const flag = issue.flag ?? 'unknown'

        if (severity === 'error') {
          errorCount++
          if (confidence === 'high') criticalCount++
        } else if (severity === 'warning') {
          warningCount++
        } else {
          infoCount++
        }

        if (!breakdown[flag]) {
          breakdown[flag] = { count: 0, errorCount: 0, warningCount: 0, infoCount: 0 }
        }
        breakdown[flag].count++
        if (severity === 'error') breakdown[flag].errorCount++
        else if (severity === 'warning') breakdown[flag].warningCount++
        else breakdown[flag].infoCount++
      }

      // For functions with flags but no detailed issues (v1 rows),
      // count each flag as a warning
      if (issues.length === 0) {
        const flags = analysis?.securityFlags ?? []
        for (const flag of flags) {
          warningCount++
          if (!breakdown[flag]) {
            breakdown[flag] = { count: 0, errorCount: 0, warningCount: 0, infoCount: 0 }
          }
          breakdown[flag].count++
          breakdown[flag].warningCount++
        }
      }
    }

    // Posture: critical only if truly exploitable (error+high confidence)
    const posture: SecurityDashboardStats['posture'] =
      criticalCount > 0 ? 'critical' : (errorCount + warningCount) > 0 ? 'warning' : 'clean'

    return {
      posture,
      criticalCount,
      errorCount,
      warningCount,
      infoCount,
      totalFunctions: fnRes.count ?? 0,
      breakdown,
    }
  })
