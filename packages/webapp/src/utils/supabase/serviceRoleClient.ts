import { createClient } from '@supabase/supabase-js'

/**
 * Service role client for admin-level operations (e.g., generating CLI auth tokens).
 * Uses @supabase/supabase-js (NOT @supabase/ssr) -- the SSR version uses cookie-based
 * sessions which gives incorrect privileges for service role operations.
 */
export function getSupabaseServiceRoleClient() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment',
    )
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}
