import { createServerFn } from '@tanstack/react-start'
import { authentication } from '@/middleware/auth'
import { getSupabaseServiceRoleClient } from '@/utils/supabase/serviceRoleClient'

export type GenerateCliTokenResponse =
  | { error: string; token_hash: null }
  | { error: null; token_hash: string }

/**
 * Generate an independent auth token for the CLI.
 * Uses admin.generateLink to create a magic link token that the CLI
 * exchanges via verifyOtp -- giving it its own session separate from
 * the browser's session (avoids refresh token rotation conflicts).
 */
export const generateCliToken = createServerFn({ method: 'POST' })
  .middleware([authentication])
  .handler(async ({ context }): Promise<GenerateCliTokenResponse> => {
    const { user } = context

    if (!user.email) {
      return { error: 'User has no email address', token_hash: null }
    }

    const serviceClient = getSupabaseServiceRoleClient()

    const { data, error } = await serviceClient.auth.admin.generateLink({
      type: 'magiclink',
      email: user.email,
    })

    if (error) {
      console.error('Failed to generate CLI token:', error.message)
      return {
        error: 'Failed to generate authorization token',
        token_hash: null,
      }
    }

    const tokenHash = data.properties?.hashed_token
    if (!tokenHash) {
      return { error: 'No token hash returned', token_hash: null }
    }

    return { error: null, token_hash: tokenHash }
  })
