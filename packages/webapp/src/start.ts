import { createStart } from '@tanstack/react-start'
import { supabaseMW } from '@/middleware/supabaseClient'

export const startInstance = createStart(() => {
  return {
    requestMiddleware: [supabaseMW],
  }
})
