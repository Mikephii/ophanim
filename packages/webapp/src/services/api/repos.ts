import { createServerFn } from '@tanstack/react-start'
import type { Repo, RepoSummary } from './types'

export const getRepos = createServerFn().handler(
  async ({ context }): Promise<RepoSummary[]> => {
    const { SBServerClient: supabase } = context as any

    const { data: repos, error } = await supabase
      .from('repos')
      .select('id, name, remote_url, created_at, updated_at')
      .order('updated_at', { ascending: false })

    if (error || !repos) return []

    const repoIds = repos.map((r: any) => r.id)
    if (repoIds.length === 0) return []

    const [fnCounts, secCounts] = await Promise.all([
      supabase
        .from('function_locations')
        .select('repo_id')
        .in('repo_id', repoIds),
      supabase
        .from('function_analysis')
        .select('repo_id')
        .in('repo_id', repoIds)
        .eq('analysis_type', 'security')
        .eq('has_security_flags', true),
    ])

    const fnMap: Record<string, number> = {}
    const secMap: Record<string, number> = {}
    for (const row of fnCounts.data ?? []) {
      fnMap[row.repo_id] = (fnMap[row.repo_id] || 0) + 1
    }
    for (const row of secCounts.data ?? []) {
      secMap[row.repo_id] = (secMap[row.repo_id] || 0) + 1
    }

    return repos.map((repo: any) => ({
      ...repo,
      functionCount: fnMap[repo.id] || 0,
      securityIssueCount: secMap[repo.id] || 0,
    }))
  },
)

export const getRepo = createServerFn({ method: 'GET' })
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data, context }): Promise<Repo | null> => {
    const { SBServerClient: supabase } = context as any

    const { data: repo, error } = await supabase
      .from('repos')
      .select('id, name, remote_url, docs_branch, last_docs_sync_commit, last_docs_sync_at, created_at, updated_at')
      .eq('id', data.id)
      .single()

    if (error || !repo) return null
    return repo
  })
