import { createServerFn } from '@tanstack/react-start'
import type { DismissedIssue, DismissReason } from './types'

/** Dismiss a security issue */
export const dismissIssue = createServerFn({ method: 'POST' })
  .inputValidator(
    (data: {
      repoId: string
      contentHash: string
      issueIndex: number
      flag: string
      reason: DismissReason
      note?: string
    }) => data,
  )
  .handler(async ({ data, context }) => {
    const { SBServerClient: supabase } = context as any
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) throw new Error('Not authenticated')

    const { error } = await supabase.from('dismissed_issues').upsert(
      {
        repo_id: data.repoId,
        content_hash: data.contentHash,
        issue_index: data.issueIndex,
        flag: data.flag,
        reason: data.reason,
        note: data.note ?? null,
        dismissed_by: user.id,
      },
      { onConflict: 'repo_id,content_hash,issue_index,dismissed_by' },
    )
    if (error) throw new Error(`Failed to dismiss: ${error.message}`)
    return { success: true }
  })

/** Undismiss (restore) a security issue */
export const undismissIssue = createServerFn({ method: 'POST' })
  .inputValidator(
    (data: {
      repoId: string
      contentHash: string
      issueIndex: number
    }) => data,
  )
  .handler(async ({ data, context }) => {
    const { SBServerClient: supabase } = context as any
    const { error } = await supabase
      .from('dismissed_issues')
      .delete()
      .eq('repo_id', data.repoId)
      .eq('content_hash', data.contentHash)
      .eq('issue_index', data.issueIndex)
    if (error) throw new Error(`Failed to undismiss: ${error.message}`)
    return { success: true }
  })

/** Get all dismissed issues for a repo (for client-side filtering) */
export const getDismissedIssues = createServerFn({ method: 'GET' })
  .inputValidator((data: { repoId: string }) => data)
  .handler(async ({ data, context }): Promise<DismissedIssue[]> => {
    const { SBServerClient: supabase } = context as any
    const { data: rows } = await supabase
      .from('dismissed_issues')
      .select(
        'content_hash, issue_index, flag, reason, note, dismissed_at',
      )
      .eq('repo_id', data.repoId)
    return (rows ?? []) as DismissedIssue[]
  })
