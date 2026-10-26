import { createServerFn } from '@tanstack/react-start'
import { buildAnalysisMap, mergeAnalysisRows } from './merge'
import type {
  EnrichedFunction,
  PaginatedResult,
  FunctionFilters,
  PaginationParams,
  SecurityFilters,
  MergedAnalysis,
} from './types'

const EMPTY_ANALYSIS: MergedAnalysis = {
  documentation: {
    description: '',
    params: [],
    returns: { type: 'unknown', description: '' },
  },
  security: { dataTags: [], securityFlags: [], issues: [] },
  practices: { violations: [] },
}

/**
 * Locations-first query: paginate locations, then batch-fetch analysis rows.
 *
 * securityOnly fix: pre-queries flagged content_hashes from the security
 * analysis table, then filters locations at the DB level (correct pagination).
 */
export const getEnrichedFunctions = createServerFn({ method: 'GET' })
  .inputValidator(
    (data: { repoId: string } & FunctionFilters & PaginationParams) => data,
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<PaginatedResult<EnrichedFunction>> => {
      const { SBServerClient: supabase } = context as any
      const page = data.page ?? 0
      const pageSize = data.pageSize ?? 25
      const from = page * pageSize
      const to = from + pageSize - 1

      // If securityOnly, pre-query flagged hashes for correct pagination
      let flaggedHashes: string[] | undefined
      if (data.securityOnly) {
        const { data: secRows } = await supabase
          .from('function_analysis')
          .select('content_hash')
          .eq('repo_id', data.repoId)
          .eq('analysis_type', 'security')
          .eq('has_security_flags', true)

        const hashes: string[] = secRows?.map((r: any) => r.content_hash) ?? []
        flaggedHashes = hashes
        if (hashes.length === 0) {
          return { data: [], total: 0, page, pageSize }
        }
      }

      // Paginate locations (filtered to flagged hashes if securityOnly)
      let locQuery = supabase
        .from('function_locations')
        .select(
          'file_path, function_name, content_hash, language, entity_type, start_line',
          { count: 'exact' },
        )
        .eq('repo_id', data.repoId)

      if (flaggedHashes) {
        locQuery = locQuery.in('content_hash', flaggedHashes)
      }

      if (data.language) {
        locQuery = locQuery.eq('language', data.language)
      }

      if (data.search) {
        locQuery = locQuery.or(
          `function_name.ilike.%${data.search}%,file_path.ilike.%${data.search}%`,
        )
      }

      locQuery = locQuery
        .order('file_path')
        .order('function_name')
        .range(from, to)

      const { data: locations, error, count } = await locQuery

      if (error || !locations || locations.length === 0) {
        return { data: [], total: count ?? 0, page, pageSize }
      }

      // Batch-fetch analysis rows for this page's content hashes
      const hashes = [...new Set(locations.map((l: any) => l.content_hash))]

      const { data: analysisRows } = await supabase
        .from('function_analysis')
        .select('content_hash, analysis_type, analysis')
        .eq('repo_id', data.repoId)
        .in('content_hash', hashes)

      const analysisMap = buildAnalysisMap(analysisRows ?? [])

      const enriched: EnrichedFunction[] = locations.map((loc: any) => ({
        file_path: loc.file_path,
        function_name: loc.function_name,
        content_hash: loc.content_hash,
        language: loc.language,
        entity_type: loc.entity_type,
        start_line: loc.start_line ?? 0,
        analysis: analysisMap.get(loc.content_hash) ?? EMPTY_ANALYSIS,
      }))

      return { data: enriched, total: count ?? 0, page, pageSize }
    },
  )

/**
 * Single function detail: parallel fetch location + analysis rows, merge.
 */
export const getEnrichedFunction = createServerFn({ method: 'GET' })
  .inputValidator((data: { repoId: string; contentHash: string }) => data)
  .handler(async ({ data, context }): Promise<EnrichedFunction | null> => {
    const { SBServerClient: supabase } = context as any

    const [locRes, analysisRes] = await Promise.all([
      supabase
        .from('function_locations')
        .select(
          'file_path, function_name, content_hash, language, entity_type, start_line',
        )
        .eq('repo_id', data.repoId)
        .eq('content_hash', data.contentHash)
        .limit(1)
        .single(),
      supabase
        .from('function_analysis')
        .select('content_hash, analysis_type, analysis')
        .eq('repo_id', data.repoId)
        .eq('content_hash', data.contentHash),
    ])

    if (locRes.error || !locRes.data) return null

    const loc = locRes.data
    const analysis = mergeAnalysisRows(analysisRes.data ?? [])

    return {
      file_path: loc.file_path,
      function_name: loc.function_name,
      content_hash: loc.content_hash,
      language: loc.language,
      entity_type: loc.entity_type,
      start_line: loc.start_line ?? 0,
      analysis,
    }
  })

/**
 * Analysis-first query: paginate security rows by flag count,
 * then hydrate with locations + doc rows.
 *
 * Supports filtering by specific flag or data tag via JSONB containment.
 */
export const getSecurityIssues = createServerFn({ method: 'GET' })
  .inputValidator(
    (data: { repoId: string } & SecurityFilters & PaginationParams) => data,
  )
  .handler(
    async ({
      data,
      context,
    }): Promise<PaginatedResult<EnrichedFunction>> => {
      const { SBServerClient: supabase } = context as any
      const page = data.page ?? 0
      const pageSize = data.pageSize ?? 25
      const from = page * pageSize
      const to = from + pageSize - 1

      // Paginate security analysis rows (sorted by flag count descending)
      let secQuery = supabase
        .from('function_analysis')
        .select('content_hash, analysis_type, analysis', { count: 'exact' })
        .eq('repo_id', data.repoId)
        .eq('analysis_type', 'security')
        .eq('has_security_flags', true)
        .order('security_flag_count', { ascending: false })
        .range(from, to)

      if (data.flag) {
        secQuery = secQuery.contains('analysis', {
          securityFlags: [data.flag],
        })
      }
      if (data.dataTag) {
        secQuery = secQuery.contains('analysis', {
          dataTags: [data.dataTag],
        })
      }
      if (data.severity) {
        secQuery = secQuery.contains('analysis', {
          issues: [{ severity: data.severity }],
        })
      }

      const { data: secRows, error, count } = await secQuery

      if (error || !secRows || secRows.length === 0) {
        return { data: [], total: count ?? 0, page, pageSize }
      }

      const hashes = secRows.map((r: any) => r.content_hash)

      // Hydrate: fetch locations + doc rows in parallel
      const [locRes, docRes] = await Promise.all([
        supabase
          .from('function_locations')
          .select(
            'file_path, function_name, content_hash, language, entity_type, start_line',
          )
          .eq('repo_id', data.repoId)
          .in('content_hash', hashes),
        supabase
          .from('function_analysis')
          .select('content_hash, analysis_type, analysis')
          .eq('repo_id', data.repoId)
          .eq('analysis_type', 'documentation')
          .in('content_hash', hashes),
      ])

      // Build location map (hash -> first location)
      const locMap = new Map<string, any>()
      for (const loc of locRes.data ?? []) {
        if (!locMap.has(loc.content_hash)) {
          locMap.set(loc.content_hash, loc)
        }
      }

      // Build doc map
      const docMap = new Map<string, any>()
      for (const doc of docRes.data ?? []) {
        docMap.set(doc.content_hash, doc.analysis ?? {})
      }

      const enriched: EnrichedFunction[] = []
      for (const secRow of secRows) {
        const loc = locMap.get(secRow.content_hash)
        if (!loc) continue // orphaned analysis row, skip

        const docAnalysis = docMap.get(secRow.content_hash) ?? {}
        const secAnalysis = secRow.analysis ?? {}

        enriched.push({
          file_path: loc.file_path,
          function_name: loc.function_name,
          content_hash: secRow.content_hash,
          language: loc.language,
          entity_type: loc.entity_type,
          start_line: loc.start_line ?? 0,
          analysis: {
            documentation: {
              description: docAnalysis.description ?? '',
              params: docAnalysis.params ?? [],
              returns: docAnalysis.returns ?? {
                type: 'unknown',
                description: '',
              },
            },
            security: {
              dataTags: secAnalysis.dataTags ?? [],
              securityFlags: secAnalysis.securityFlags ?? [],
              issues: secAnalysis.issues ?? [],
            },
            practices: { violations: [] },
          },
        })
      }

      return { data: enriched, total: count ?? 0, page, pageSize }
    },
  )
