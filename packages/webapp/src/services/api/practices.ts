import { createServerFn } from '@tanstack/react-start'
import { MAX_PRACTICES, MAX_RULE_LENGTH } from '@ophan/core/schemas'

export interface RepoPractice {
  id: string
  practice_id: string
  rule: string
  severity: 'error' | 'warning' | 'info'
  created_at: string
  updated_at: string
}

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * List all practices for a repo.
 */
export const getPractices = createServerFn({ method: 'GET' })
  .inputValidator((data: { repoId: string }) => data)
  .handler(async ({ data, context }): Promise<RepoPractice[]> => {
    const { SBServerClient: supabase } = context as any
    const { data: rows, error } = await supabase
      .from('repo_practices')
      .select('id, practice_id, rule, severity, created_at, updated_at')
      .eq('repo_id', data.repoId)
      .order('created_at')
    if (error || !rows) return []
    return rows
  })

/**
 * Create a new practice for a repo.
 */
export const createPractice = createServerFn({ method: 'POST' })
  .inputValidator(
    (data: {
      repoId: string
      practiceId: string
      rule: string
      severity: 'error' | 'warning' | 'info'
    }) => data,
  )
  .handler(async ({ data, context }) => {
    const { SBServerClient: supabase } = context as any

    // Validate
    if (!data.practiceId || !ID_PATTERN.test(data.practiceId)) {
      throw new Error(
        'Practice ID must be kebab-case (lowercase letters, numbers, hyphens)',
      )
    }
    if (!data.rule || data.rule.length > MAX_RULE_LENGTH) {
      throw new Error(`Rule must be 1-${MAX_RULE_LENGTH} characters`)
    }
    if (!['error', 'warning', 'info'].includes(data.severity)) {
      throw new Error('Severity must be error, warning, or info')
    }

    // Check limit
    const { count } = await supabase
      .from('repo_practices')
      .select('id', { count: 'exact', head: true })
      .eq('repo_id', data.repoId)
    if (count !== null && count >= MAX_PRACTICES) {
      throw new Error(`Maximum ${MAX_PRACTICES} practices per repository`)
    }

    const { error } = await supabase.from('repo_practices').insert({
      repo_id: data.repoId,
      practice_id: data.practiceId,
      rule: data.rule,
      severity: data.severity,
    })
    if (error) {
      if (error.code === '23505') {
        throw new Error(
          `Practice "${data.practiceId}" already exists in this repository`,
        )
      }
      throw new Error(`Failed to create practice: ${error.message}`)
    }
    return { success: true }
  })

/**
 * Update an existing practice.
 */
export const updatePractice = createServerFn({ method: 'POST' })
  .inputValidator(
    (data: {
      repoId: string
      id: string
      rule?: string
      severity?: 'error' | 'warning' | 'info'
    }) => data,
  )
  .handler(async ({ data, context }) => {
    const { SBServerClient: supabase } = context as any

    const updates: Record<string, string> = {}
    if (data.rule !== undefined) {
      if (!data.rule || data.rule.length > MAX_RULE_LENGTH) {
        throw new Error(`Rule must be 1-${MAX_RULE_LENGTH} characters`)
      }
      updates.rule = data.rule
    }
    if (data.severity !== undefined) {
      if (!['error', 'warning', 'info'].includes(data.severity)) {
        throw new Error('Severity must be error, warning, or info')
      }
      updates.severity = data.severity
    }

    if (Object.keys(updates).length === 0) {
      return { success: true }
    }

    const { error } = await supabase
      .from('repo_practices')
      .update(updates)
      .eq('id', data.id)
      .eq('repo_id', data.repoId)
    if (error) {
      throw new Error(`Failed to update practice: ${error.message}`)
    }
    return { success: true }
  })

/**
 * Delete a practice.
 */
export const deletePractice = createServerFn({ method: 'POST' })
  .inputValidator((data: { repoId: string; id: string }) => data)
  .handler(async ({ data, context }) => {
    const { SBServerClient: supabase } = context as any
    const { error } = await supabase
      .from('repo_practices')
      .delete()
      .eq('id', data.id)
      .eq('repo_id', data.repoId)
    if (error) {
      throw new Error(`Failed to delete practice: ${error.message}`)
    }
    return { success: true }
  })
