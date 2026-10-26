import { redirect } from '@tanstack/react-router'
import { createMiddleware } from '@tanstack/react-start'
import { supabaseMW } from '@/middleware/supabaseClient'

export const authentication = createMiddleware({ type: 'function' })
  .middleware([supabaseMW])
  .server(async ({ next, context }) => {
    const { SBServerClient: supabase } = context
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      throw redirect({ to: '/signin' })
    }

    return next({
      context: {
        user,
      },
    })
  })
