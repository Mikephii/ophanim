import { useState } from 'react'
import { createFileRoute, redirect, Link, useRouter } from '@tanstack/react-router'
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
import { useTheme } from '@/hooks/use-theme'
import {
  signInWithPassword,
  signUpWithPassword,
} from '@/services/auth/auth'
import {
  IconShield,
  IconSun,
  IconMoon,
  IconLoader2,
} from '@tabler/icons-react'

export const Route = createFileRoute('/signin')({
  beforeLoad: async ({ context }) => {
    if (context.authSession) {
      throw redirect({ to: '/dashboard', statusCode: 302 })
    }
  },
  component: SignInPage,
})

function SignInPage() {
  const [isSignUp, setIsSignUp] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const { theme, toggleTheme } = useTheme()

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
      } else {
        router.navigate({ to: '/dashboard' })
      }
    } catch (err) {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-6 py-4">
        <Link to="/" className="flex items-center gap-2 text-lg font-semibold">
          <IconShield className="size-5 text-primary" />
          Ophan
        </Link>
        <Button variant="ghost" size="icon" onClick={toggleTheme}>
          {theme === 'dark' ? (
            <IconSun className="size-4" />
          ) : (
            <IconMoon className="size-4" />
          )}
        </Button>
      </header>

      <main className="flex flex-1 items-center justify-center px-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>{isSignUp ? 'Create an account' : 'Welcome back'}</CardTitle>
            <CardDescription>
              {isSignUp
                ? 'Enter your email to create your account'
                : 'Sign in to your account to continue'}
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
