import { createFileRoute, Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/hooks/use-theme'
import { IconShield, IconSun, IconMoon } from '@tabler/icons-react'

function OphanLogo({ className }: { className?: string }) {
  return (
    <>
      <img src="/ophan-light.svg" alt="Ophan" className={`dark:hidden ${className}`} />
      <img src="/ophan-dark.svg" alt="Ophan" className={`hidden dark:block ${className}`} />
    </>
  )
}

export const Route = createFileRoute('/')({
  component: LandingPage,
})

function LandingPage() {
  const { theme, toggleTheme } = useTheme()

  return (
    <div className="bg-background text-foreground flex min-h-screen flex-col">
      <header className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <OphanLogo className="h-7" />
          Ophan
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={toggleTheme}>
            {theme === 'dark' ? (
              <IconSun className="size-4" />
            ) : (
              <IconMoon className="size-4" />
            )}
          </Button>
          <Button variant="ghost" asChild>
            <Link to="/signin">Sign in</Link>
          </Button>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="mx-auto max-w-2xl text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm text-muted-foreground">
            <IconShield className="size-4 text-primary" />
            Self-hosted Ophan server
          </div>

          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl">
            Ophan
            <br />
            <span className="text-primary">security dashboard</span>
          </h1>

          <p className="mt-6 text-lg text-muted-foreground">
            Sign in to see the analysis synced from your machines: security
            findings, data flows, and generated docs for every repo.
          </p>

          <div className="mt-10 flex items-center justify-center gap-4">
            <Button size="lg" asChild>
              <Link to="/signin">Sign in</Link>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <a href="https://github.com/Mikephii/ophanim" target="_blank" rel="noopener noreferrer">
                Documentation
              </a>
            </Button>
          </div>
        </div>
      </main>

      <footer className="px-6 py-6 text-center text-sm text-muted-foreground">
        <a href="https://github.com/Mikephii/ophanim" className="hover:underline">
          Ophan on GitHub
        </a>
      </footer>
    </div>
  )
}
