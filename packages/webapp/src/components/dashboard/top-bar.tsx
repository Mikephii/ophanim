import { Link, useMatches, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { signOut } from '@/services/auth/auth'
import { repoQueries } from '@/services/queries'
import { IconSettings, IconLogout } from '@tabler/icons-react'
import type { SerializableUser } from '@/services/auth/auth'

export function TopBar({ user }: { user: SerializableUser | null }) {
  const router = useRouter()

  const handleSignOut = async () => {
    await signOut()
    router.invalidate()
    router.navigate({ to: '/' })
  }

  const userInitial = user?.email?.charAt(0).toUpperCase() ?? '?'

  return (
    <header className="fixed top-0 left-0 right-0 z-40 h-12 border-b border-border bg-background/95 backdrop-blur flex items-center px-4 gap-4">
      {/* Left: Brand */}
      <Link to="/dashboard" className="flex items-center gap-2 shrink-0">
        <img
          src="/ophan-light.svg"
          alt="Ophan"
          className="h-7 p-0.5 dark:hidden"
        />
        <img
          src="/ophan-dark.svg"
          alt="Ophan"
          className="h-7 p-0.5 hidden dark:block"
        />
        <span className="font-semibold text-sm hidden sm:inline">Ophan</span>
      </Link>

      {/* Breadcrumbs */}
      <DashboardBreadcrumbs />

      {/* Right: User menu */}
      <div className="ml-auto flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full size-8 p-0"
            >
              <Avatar className="size-7">
                <AvatarFallback className="text-xs">
                  {userInitial}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom" className="w-56">
            {user?.email && (
              <>
                <div className="px-2 py-1.5 text-sm text-muted-foreground truncate">
                  {user.email}
                </div>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem asChild>
              <Link to="/dashboard/settings">
                <IconSettings className="size-4" />
                Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={handleSignOut}>
              <IconLogout className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}

function DashboardBreadcrumbs() {
  const matches = useMatches()

  // Extract repoId and contentHash from route params if present
  const repoMatch = matches.find((m) => (m.params as any)?.repoId)
  const repoId = (repoMatch?.params as any)?.repoId as string | undefined

  const fnMatch = matches.find((m) => (m.params as any)?.contentHash)
  const contentHash = (fnMatch?.params as any)?.contentHash as
    | string
    | undefined

  const isSettings = matches.some((m) => m.routeId === '/dashboard/settings')
  const isDashboardHome = matches.some(
    (m) => m.routeId === '/dashboard/' && !repoId,
  )

  // Build breadcrumb segments
  const crumbs: {
    label: React.ReactNode
    to?: string
    params?: Record<string, string>
  }[] = []

  if (isDashboardHome) {
    crumbs.push({ label: 'Projects' })
  } else if (isSettings) {
    crumbs.push({ label: 'Settings' })
  } else if (repoId) {
    crumbs.push({ label: 'Projects', to: '/dashboard' })
    if (contentHash) {
      crumbs.push({
        label: <RepoNameCrumb repoId={repoId} />,
        to: '/dashboard/repos/$repoId',
        params: { repoId },
      })
      crumbs.push({ label: 'Function' })
    } else {
      crumbs.push({ label: <RepoNameCrumb repoId={repoId} /> })
    }
  }

  if (crumbs.length === 0) return null

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, i) => (
          <span key={i} className="contents">
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {crumb.to ? (
                <BreadcrumbLink asChild>
                  <Link to={crumb.to as any} params={crumb.params as any}>
                    {crumb.label}
                  </Link>
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </span>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}

function RepoNameCrumb({ repoId }: { repoId: string }) {
  const { data: repo } = useQuery(repoQueries.detail(repoId))
  return <>{repo?.name ?? 'Loading...'}</>
}
