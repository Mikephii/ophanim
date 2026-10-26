import { useState, useEffect } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  signInWithPassword,
  signUpWithPassword,
} from '@/services/auth/auth'
import { generateCliToken } from '@/services/auth/cliAuth'
import {
  IconShield,
  IconLoader2,
  IconTerminal2,
} from '@tabler/icons-react'

export const Route = createFileRoute('/auth/cli')({
  validateSearch: (search: Record<string, unknown>) => ({
    port: Number(search.port) || 0,
  }),
  component: CliAuthPage,
})

function CliAuthPage() {
  const { port } = Route.useSearch()
  const context = Route.useRouteContext()

  const [isSignUp, setIsSignUp] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [redirecting, setRedirecting] = useState(false)

  // If user is already logged in, redirect to CLI callback immediately
  useEffect(() => {
    if (context.authSession && port) {
      redirectToCli()
    }
  }, [context.authSession, port])

  async function redirectToCli() {
    setRedirecting(true)
    try {
      // Generate an independent session token for the CLI via server-side admin API.
      // This gives the CLI its own refresh token chain, separate from the browser's session.
      const result = await generateCliToken()

      if (result.error || !result.token_hash) {
        setError(result.error || 'Failed to generate CLI token. Please try again.')
        setRedirecting(false)
        return
      }

      // Only pass token_hash -- the CLI has its Supabase URL/key baked in at build time.
      const params = new URLSearchParams({
        token_hash: result.token_hash,
      })

      window.location.href = `http://localhost:${port}/callback?${params.toString()}`
    } catch {
      setError('Failed to complete authorization. Please try again.')
      setRedirecting(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const result = isSignUp
        ? await signUpWithPassword({ data: { email, password } })
        : await signInWithPassword({ data: { email, password } })

      if (result.error) {
        setError(result.error)
        setLoading(false)
        return
      }

      // Auth succeeded -- redirect to CLI callback
      if (port) {
        await redirectToCli()
      } else {
        setError('Missing port parameter. Please run `ophan login` again.')
        setLoading(false)
      }
    } catch {
      setError('Something went wrong. Please try again.')
      setLoading(false)
    }
  }

  if (!port) {
    return (
      <div className="bg-background text-foreground flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Invalid Request</CardTitle>
            <CardDescription>
              This page is used by the Ophan CLI. Run <code className="bg-muted px-1.5 py-0.5 rounded text-sm">ophan login</code> from your terminal.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  if (redirecting) {
    return (
      <div className="bg-background text-foreground flex min-h-screen items-center justify-center">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <IconLoader2 className="size-8 animate-spin text-primary mx-auto mb-2" />
            <CardTitle>Authorizing CLI...</CardTitle>
            <CardDescription>Redirecting back to your terminal.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <header className="flex items-center justify-center px-6 py-4">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <IconShield className="size-5 text-primary" />
          Ophan
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-2">
              <IconTerminal2 className="size-4" />
              Authorizing Ophan CLI
            </div>
            <CardTitle>{isSignUp ? 'Create an account' : 'Sign in to continue'}</CardTitle>
            <CardDescription>
              {isSignUp
                ? 'Create an account to sync your analysis'
                : 'Sign in to authorize the CLI on this device'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder={isSignUp ? 'Min 6 characters' : 'Enter your password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={isSignUp ? 6 : undefined}
                />
              </div>

              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}

              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <IconLoader2 className="size-4 animate-spin" />}
                {isSignUp ? 'Create account' : 'Sign in'}
              </Button>
            </form>
          </CardContent>
          <CardFooter className="justify-center">
            <button
              type="button"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => {
                setIsSignUp(!isSignUp)
                setError(null)
              }}
            >
              {isSignUp
                ? 'Already have an account? Sign in'
                : "Don't have an account? Sign up"}
            </button>
          </CardFooter>
        </Card>
      </main>
    </div>
  )
}
