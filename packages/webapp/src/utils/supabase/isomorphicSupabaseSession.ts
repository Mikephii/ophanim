import { createIsomorphicFn, createServerFn } from '@tanstack/react-start'
import { getSupabaseBrowserClient } from '@/utils/supabase/browserClient'

export type SerializableSession = {
  access_token: string
  refresh_token: string
}

export const isomorphicGetSBSession = createIsomorphicFn()
  .client(async () => {
    const supabase = getSupabaseBrowserClient()
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session) return null

    // Validate the session is still valid (e.g. after DB reset)
    const { error } = await supabase.auth.getUser()
    if (error) {
      await supabase.auth.signOut()
      return null
    }

    return {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    }
  })
  .server(async () => {
    try {
      const session = await getServerSession()
      return session
    } catch (e) {
      return null
    }
  })

const getServerSession = createServerFn().handler(async ({ context }) => {
  const { SBServerClient: supabase } = context as any
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session) return null

  const { error: authErr } = await supabase.auth.getUser()

  if (authErr) return null

  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  }
})
