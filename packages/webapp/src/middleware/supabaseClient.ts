import { createServerClient } from '@supabase/ssr'
import { createMiddleware, json } from '@tanstack/react-start'
import { getCookies, setCookie, deleteCookie } from '@/services/startWebUtils'
import { authCookieName, isAlwaysAvailable, missingServerEnv, readPublicConfigFromEnv } from '@/utils/public-config'

export const supabaseMW = createMiddleware().server(async ({ next, request }) => {
  const missing = missingServerEnv(process.env)
  if (missing.length > 0) {
    // Health and config stay up so a misconfigured server can still be diagnosed.
    // Those two routes never touch the Supabase client, so it can be absent.
    if (isAlwaysAvailable(new URL(request.url).pathname)) {
      return next({ context: { SBServerClient: undefined as unknown as ReturnType<typeof createServerClient> } })
    }
    throw json(
      { status: 503, message: `Ophan server is not configured: set ${missing.join(', ')}. See docs/self-hosting.md` },
      { status: 503 },
    )
  }

  // https://github.com/supabase/ssr/issues/67
  const cookies = getCookies()
  const cookiesArr = Object.entries(cookies)

  // Strict UTF-8 decoder -- throws on bad bytes
  const strictDecoder = new TextDecoder('utf-8', { fatal: true })
  let hasCorruptedCookie = false

  const chunkedCookies = new Map<
    string,
    { name: string; value: string; index: number }[]
  >()

  const chunkedCookieRegex = /^(sb-[a-zA-Z0-9._-]+-auth-token)\.(\d+)$/
  const standaloneCookieRegex = /^sb-[a-zA-Z0-9._-]+-auth-token$/

  cookiesArr.forEach(([name, value]) => {
    const chunkMatch = name.match(chunkedCookieRegex)

    if (chunkMatch) {
      const baseName = chunkMatch[1]
      const index = parseInt(chunkMatch[2])

      if (!chunkedCookies.has(baseName)) {
        chunkedCookies.set(baseName, [])
      }
      chunkedCookies.get(baseName)!.push({ name, value: value || '', index })
    } else if (
      name.match(standaloneCookieRegex) &&
      value?.startsWith('base64-')
    ) {
      chunkedCookies.set(name, [{ name, value: value || '', index: 0 }])
    }
  })

  // Validate each cookie group
  chunkedCookies.forEach((chunks, baseName) => {
    chunks.sort((a, b) => a.index - b.index)
    const combinedValue = chunks.map((c) => c.value).join('')

    if (combinedValue.startsWith('base64-')) {
      try {
        const raw = combinedValue.slice(7)
        const buffer = Buffer.from(raw, 'base64')
        strictDecoder.decode(buffer)
      } catch (e) {
        console.error(`Corrupted Supabase session detected in ${baseName}`)
        chunks.forEach((chunk) => {
          deleteCookie(chunk.name)
          hasCorruptedCookie = true
        })
      }
    }
  })

  if (hasCorruptedCookie) {
    throw json({ status: 400, message: 'Bad Request - Corrupted Cookies' })
  }

  const client = createServerClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
      // Same cookie name as the browser client, even when SUPABASE_URL is an internal address
      cookieOptions: { name: authCookieName(readPublicConfigFromEnv(process.env)) },
      cookies: {
        getAll() {
          return Object.entries(getCookies()).map(([name, value]) => ({
            name,
            value,
          }))
        },
        setAll(cookies) {
          cookies.forEach((cookie) => {
            try {
              setCookie(cookie.name, cookie.value)
            } catch (e) {
              // Swallow -- headers may already be sent during SSR streaming
            }
          })
        },
      },
    },
  )

  return next({
    context: {
      SBServerClient: client,
    },
  })
})
