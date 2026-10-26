import { createBrowserClient } from '@supabase/ssr'
import { authCookieName, getPublicConfig } from '@/utils/public-config'

export function getSupabaseBrowserClient() {
  const config = getPublicConfig()
  const { supabaseUrl, supabaseAnonKey } = config

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase URL or Anon Key is not set')
  }
  return createBrowserClient(supabaseUrl, supabaseAnonKey, {
    cookieOptions: { name: authCookieName(config) },
  })
}
