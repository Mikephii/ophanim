import { describe, it, expect } from 'vitest'
import { authCookieName, isAlwaysAvailable, missingServerEnv, publicConfigScript, readPublicConfigFromEnv } from './public-config'

describe('readPublicConfigFromEnv', () => {
  it('uses SUPABASE_URL for clients when no public URL is set', () => {
    expect(readPublicConfigFromEnv({ SUPABASE_URL: 'http://kong:8000', SUPABASE_ANON_KEY: 'anon' })).toEqual({
      supabaseUrl: 'http://kong:8000',
      supabaseAnonKey: 'anon',
    })
  })

  it('prefers SUPABASE_PUBLIC_URL over SUPABASE_URL', () => {
    const config = readPublicConfigFromEnv({
      SUPABASE_URL: 'http://kong:8000',
      SUPABASE_PUBLIC_URL: 'https://supabase.example.com',
      SUPABASE_ANON_KEY: 'anon',
    })
    expect(config.supabaseUrl).toBe('https://supabase.example.com')
  })

  it('never exposes the service role key', () => {
    const config = readPublicConfigFromEnv({ SUPABASE_URL: 'u', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 'secret' })
    expect(JSON.stringify(config)).not.toContain('secret')
  })

  it('returns empty strings when unconfigured', () => {
    expect(readPublicConfigFromEnv({})).toEqual({ supabaseUrl: '', supabaseAnonKey: '' })
  })
})

describe('publicConfigScript', () => {
  it('escapes < so a value cannot close the script tag', () => {
    const script = publicConfigScript({ supabaseUrl: '</script><script>alert(1)</script>', supabaseAnonKey: 'a' })
    expect(script).not.toContain('</script>')
    expect(script.startsWith('window.__OPHAN_CONFIG__=')).toBe(true)
  })
})

describe('authCookieName', () => {
  it('follows the public URL so server and browser share one cookie', () => {
    const server = readPublicConfigFromEnv({ SUPABASE_URL: 'http://host.docker.internal:54321', SUPABASE_PUBLIC_URL: 'http://127.0.0.1:54321' })
    expect(authCookieName(server)).toBe('sb-127-auth-token')
    expect(authCookieName({ supabaseUrl: 'https://abcd.supabase.co', supabaseAnonKey: 'a' })).toBe('sb-abcd-auth-token')
  })

  it('still returns a name when unconfigured', () => {
    expect(authCookieName({ supabaseUrl: '', supabaseAnonKey: '' })).toBe('sb-local-auth-token')
  })
})

describe('missingServerEnv', () => {
  it('lists every required variable that is unset', () => {
    expect(missingServerEnv({})).toEqual(['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'])
    expect(missingServerEnv({ SUPABASE_URL: 'u', SUPABASE_ANON_KEY: 'a' })).toEqual(['SUPABASE_SERVICE_ROLE_KEY'])
    expect(missingServerEnv({ SUPABASE_URL: 'u', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's' })).toEqual([])
  })
})

describe('isAlwaysAvailable', () => {
  it('keeps health and config reachable on an unconfigured server', () => {
    expect(isAlwaysAvailable('/api/health')).toBe(true)
    expect(isAlwaysAvailable('/api/config/')).toBe(true)
    expect(isAlwaysAvailable('/dashboard')).toBe(false)
    expect(isAlwaysAvailable('/api/healthz')).toBe(false)
  })
})
