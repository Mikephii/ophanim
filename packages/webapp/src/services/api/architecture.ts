import { createServerFn } from '@tanstack/react-start'
import type {
  ArchitectureHierarchy,
  CommunitySummary,
  CrossCuttingConcern,
  DocsSyncHistoryEntry,
  EnrichedL1Summary,
  L1Group,
  RelatedCommunity,
} from './types'

/**
 * Get the full architecture hierarchy for a repo.
 * Returns L3 (if exists), all L2s, and all L1s in a single response.
 */
export const getArchitectureHierarchy = createServerFn({ method: 'GET' })
  .inputValidator(
    (data: { repoId: string; algorithm?: string }) => data,
  )
  .handler(async ({ data, context }): Promise<ArchitectureHierarchy> => {
    const { SBServerClient: supabase } = context as any
    const algorithm = data.algorithm ?? 'leiden'

    const [l3Res, l2Res, l1Res, ccRes, hierRes] = await Promise.all([
      supabase
        .from('community_summaries')
        .select(
          'community_id, level, algorithm, input_hash, summary, model_version',
        )
        .eq('repo_id', data.repoId)
        .eq('algorithm', algorithm)
        .eq('level', 3)
        .limit(1)
        .maybeSingle(),
      supabase
        .from('community_summaries')
        .select(
          'community_id, level, algorithm, input_hash, summary, model_version',
        )
        .eq('repo_id', data.repoId)
        .eq('algorithm', algorithm)
        .eq('level', 2)
        .order('community_id'),
      supabase
        .from('community_summaries')
        .select(
          'community_id, level, algorithm, input_hash, summary, model_version',
        )
        .eq('repo_id', data.repoId)
        .eq('algorithm', algorithm)
        .eq('level', 1)
        .order('community_id'),
      supabase
        .from('community_summaries')
        .select(
          'community_id, level, algorithm, input_hash, summary, model_version',
        )
        .eq('repo_id', data.repoId)
        .eq('algorithm', algorithm)
        .eq('level', 10)
        .order('community_id'),
      // Fetch L1 hierarchy assignments (level=1 in communities table)
      supabase
        .from('communities')
        .select('content_hash, community_id')
        .eq('repo_id', data.repoId)
        .eq('algorithm', algorithm)
        .eq('level', 1)
        .neq('community_id', '__dissolved'),
    ])

    const l1Summaries = (l1Res.data ?? []) as CommunitySummary[]
    const l2Summaries = (l2Res.data ?? []) as CommunitySummary[]

    // Build groups from hierarchy
    const groups: L1Group[] = []
    const hierRows = hierRes.data ?? []
    if (hierRows.length > 0) {
      // Map: L0 community_id → L1 group_id
      const l0ToGroup = new Map<string, string>()
      for (const row of hierRows as { content_hash: string; community_id: string }[]) {
        l0ToGroup.set(row.content_hash, row.community_id)
      }

      // Map: L2 community_id → full summary (for group names + overview content)
      const l2ByGroupId = new Map<string, CommunitySummary>()
      for (const s of l2Summaries) {
        l2ByGroupId.set(s.community_id, s)
      }

      // Group L1 summaries by parent
      const groupMap = new Map<string, CommunitySummary[]>()
      for (const s of l1Summaries) {
        const groupId = l0ToGroup.get(s.community_id)
        if (groupId) {
          const list = groupMap.get(groupId) || []
          list.push(s)
          groupMap.set(groupId, list)
        }
      }

      for (const [groupId, members] of groupMap) {
        if (members.length > 0) {
          const l2Summary = l2ByGroupId.get(`group_${groupId}`)
          groups.push({
            groupId,
            title: l2Summary?.summary.title ?? `Group ${groupId}`,
            l1Communities: members,
            overview: l2Summary,
          })
        }
      }
    }

    return {
      l3: l3Res.data ?? null,
      l2: l2Summaries,
      l1: l1Summaries,
      crossCutting: (ccRes.data ?? []) as CrossCuttingConcern[],
      groups,
    }
  })

/**
 * Get a single cross-cutting concern detail.
 */
export const getConcernDetail = createServerFn({ method: 'GET' })
  .inputValidator(
    (data: { repoId: string; concernId: string; algorithm?: string }) => data,
  )
  .handler(async ({ data, context }): Promise<CrossCuttingConcern | null> => {
    const { SBServerClient: supabase } = context as any
    const algorithm = data.algorithm ?? 'leiden'

    const { data: row, error } = await supabase
      .from('community_summaries')
      .select(
        'community_id, level, algorithm, input_hash, summary, model_version',
      )
      .eq('repo_id', data.repoId)
      .eq('community_id', data.concernId)
      .eq('algorithm', algorithm)
      .eq('level', 10)
      .single()

    if (error || !row) return null
    return row as CrossCuttingConcern
  })

/**
 * Get a single L1 community detail with its member functions.
 */
export const getCommunityDetail = createServerFn({ method: 'GET' })
  .inputValidator(
    (data: { repoId: string; communityId: string; algorithm?: string }) =>
      data,
  )
  .handler(async ({ data, context }): Promise<EnrichedL1Summary | null> => {
    const { SBServerClient: supabase } = context as any
    const algorithm = data.algorithm ?? 'leiden'

    const [summaryRes, membersRes, ceSourceRes, ceTargetRes, ccRes, parentGroupRes] = await Promise.all([
      supabase
        .from('community_summaries')
        .select(
          'community_id, level, algorithm, input_hash, summary, model_version',
        )
        .eq('repo_id', data.repoId)
        .eq('community_id', data.communityId)
        .eq('algorithm', algorithm)
        .eq('level', 1)
        .single(),
      supabase
        .from('communities')
        .select('content_hash')
        .eq('repo_id', data.repoId)
        .eq('community_id', data.communityId)
        .eq('algorithm', algorithm)
        .eq('level', 0),
      // Community edges where this community is source
      supabase
        .from('community_edges')
        .select('source_community, target_community, weight, edge_count')
        .eq('repo_id', data.repoId)
        .eq('algorithm', algorithm)
        .eq('source_community', data.communityId),
      // Community edges where this community is target
      supabase
        .from('community_edges')
        .select('source_community, target_community, weight, edge_count')
        .eq('repo_id', data.repoId)
        .eq('algorithm', algorithm)
        .eq('target_community', data.communityId),
      // Cross-cutting concerns (level=10)
      supabase
        .from('community_summaries')
        .select(
          'community_id, level, algorithm, input_hash, summary, model_version',
        )
        .eq('repo_id', data.repoId)
        .eq('algorithm', algorithm)
        .eq('level', 10),
      // Parent group (level=1 in communities table)
      supabase
        .from('communities')
        .select('community_id')
        .eq('repo_id', data.repoId)
        .eq('algorithm', algorithm)
        .eq('level', 1)
        .eq('content_hash', data.communityId)
        .neq('community_id', '__dissolved')
        .maybeSingle(),
    ])

    if (summaryRes.error || !summaryRes.data) return null

    const memberHashes = (membersRes.data ?? []).map(
      (r: any) => r.content_hash,
    )

    let members: EnrichedL1Summary['members'] = []
    if (memberHashes.length > 0) {
      const [locRes, docRes] = await Promise.all([
        supabase
          .from('function_locations')
          .select('content_hash, function_name, file_path')
          .eq('repo_id', data.repoId)
          .in('content_hash', memberHashes),
        supabase
          .from('function_analysis')
          .select('content_hash, analysis')
          .eq('repo_id', data.repoId)
          .eq('analysis_type', 'documentation')
          .in('content_hash', memberHashes),
      ])

      const docMap = new Map<string, string>()
      for (const row of docRes.data ?? []) {
        docMap.set(
          row.content_hash,
          (row.analysis as any)?.description ?? '',
        )
      }

      members = (locRes.data ?? []).map((loc: any) => ({
        content_hash: loc.content_hash,
        function_name: loc.function_name,
        file_path: loc.file_path,
        description: docMap.get(loc.content_hash) ?? '',
      }))
    }

    // Build related communities from community edges
    const relatedMap = new Map<string, { weight: number; edgeCount: number }>()
    for (const row of ceSourceRes.data ?? []) {
      const other = row.target_community
      if (other !== data.communityId) {
        relatedMap.set(other, { weight: row.weight, edgeCount: row.edge_count })
      }
    }
    for (const row of ceTargetRes.data ?? []) {
      const other = row.source_community
      if (other !== data.communityId && !relatedMap.has(other)) {
        relatedMap.set(other, { weight: row.weight, edgeCount: row.edge_count })
      }
    }

    // Fetch titles for related communities
    let relatedCommunities: RelatedCommunity[] = []
    const relatedIds = [...relatedMap.keys()]
    if (relatedIds.length > 0) {
      const { data: relatedSummaries } = await supabase
        .from('community_summaries')
        .select('community_id, summary')
        .eq('repo_id', data.repoId)
        .eq('algorithm', algorithm)
        .eq('level', 1)
        .in('community_id', relatedIds)

      const titleMap = new Map<string, string>()
      for (const s of relatedSummaries ?? []) {
        titleMap.set(s.community_id, (s.summary as any)?.title ?? s.community_id)
      }

      relatedCommunities = relatedIds.map((id) => ({
        communityId: id,
        title: titleMap.get(id) ?? id,
        weight: relatedMap.get(id)!.weight,
        edgeCount: relatedMap.get(id)!.edgeCount,
      })).sort((a, b) => b.weight - a.weight)
    }

    // Filter concerns that affect this community
    const allConcerns = (ccRes.data ?? []) as CrossCuttingConcern[]
    const relatedConcerns = allConcerns.filter((c) =>
      c.summary.affectedCommunities?.some(
        (ac) => ac.communityId === data.communityId,
      ),
    )

    // Build parent group
    let parentGroup: EnrichedL1Summary['parentGroup'] = null
    if (parentGroupRes.data) {
      const groupId = (parentGroupRes.data as any).community_id
      // Try to get the L2 summary for this group for the title
      const { data: l2Summary } = await supabase
        .from('community_summaries')
        .select('summary')
        .eq('repo_id', data.repoId)
        .eq('algorithm', algorithm)
        .eq('level', 2)
        .eq('community_id', `group_${groupId}`)
        .maybeSingle()

      parentGroup = {
        groupId,
        title: (l2Summary?.summary as any)?.title ?? `Group ${groupId}`,
      }
    }

    return {
      ...summaryRes.data,
      memberCount: memberHashes.length,
      members,
      relatedCommunities,
      relatedConcerns,
      parentGroup,
    }
  })

/**
 * Delete all architecture data for a repo (community_summaries, community_edges, communities).
 */
export const wipeArchitectureData = createServerFn({ method: 'POST' })
  .inputValidator((data: { repoId: string }) => data)
  .handler(async ({ data, context }) => {
    const { SBServerClient: supabase } = context as any
    await Promise.all([
      supabase.from('community_summaries').delete().eq('repo_id', data.repoId),
      supabase.from('community_edges').delete().eq('repo_id', data.repoId),
      supabase.from('communities').delete().eq('repo_id', data.repoId),
    ])
    return { success: true }
  })

/**
 * Delete all function analysis data for a repo (function_analysis, function_locations).
 */
export const wipeFunctionAnalysis = createServerFn({ method: 'POST' })
  .inputValidator((data: { repoId: string }) => data)
  .handler(async ({ data, context }) => {
    const { SBServerClient: supabase } = context as any
    await Promise.all([
      supabase.from('function_analysis').delete().eq('repo_id', data.repoId),
      supabase.from('function_locations').delete().eq('repo_id', data.repoId),
    ])
    return { success: true }
  })

/**
 * Update the docs_branch setting for a repo.
 * Architecture data is only synced from this branch.
 */
export const updateDocsBranch = createServerFn({ method: 'POST' })
  .inputValidator((data: { repoId: string; docsBranch: string }) => data)
  .handler(async ({ data, context }) => {
    const { SBServerClient: supabase } = context as any
    const { error } = await supabase
      .from('repos')
      .update({ docs_branch: data.docsBranch })
      .eq('id', data.repoId)
    if (error) {
      throw new Error(`Failed to update docs branch: ${error.message}`)
    }
    return { success: true }
  })

/**
 * Get docs sync history for a repo.
 * Returns the most recent 50 sync events (commit hash, branch, time).
 */
export const getDocsSyncHistory = createServerFn({ method: 'GET' })
  .inputValidator((data: { repoId: string }) => data)
  .handler(async ({ data, context }): Promise<DocsSyncHistoryEntry[]> => {
    const { SBServerClient: supabase } = context as any
    const { data: rows, error } = await supabase
      .from('docs_sync_history')
      .select('id, commit_hash, branch, synced_at')
      .eq('repo_id', data.repoId)
      .order('synced_at', { ascending: false })
      .limit(50)
    if (error || !rows) return []
    return rows
  })
