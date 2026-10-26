import { createFileRoute } from '@tanstack/react-router'
import { readPublicConfigFromEnv } from '@/utils/public-config'

// Lets `ophan login --server <url>` and the extension configure themselves from the
// webapp's URL alone. Only public values: the anon key is designed to be shared.
export const Route = createFileRoute('/api/config')({
  server: {
    handlers: {
      GET: async () => {
        const config = readPublicConfigFromEnv(process.env)
        if (!config.supabaseUrl || !config.supabaseAnonKey) {
          return Response.json({ error: 'Server is missing SUPABASE_URL or SUPABASE_ANON_KEY' }, { status: 503 })
        }
        return Response.json(config, { headers: { 'Cache-Control': 'no-store' } })
      },
    },
  },
})
