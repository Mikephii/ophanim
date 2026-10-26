import { createFileRoute, redirect, Outlet, useMatchRoute } from '@tanstack/react-router'
import { TopBar } from '@/components/dashboard/top-bar'
import { OverlaySidebar } from '@/components/dashboard/overlay-sidebar'
import { getAccountNavItems, getRepoNavItems } from '@/components/dashboard/nav-config'
import { authQueries } from '@/services/queries'
import type { GetUserResponse } from '@/services/auth/auth'

export const Route = createFileRoute('/dashboard')({
  beforeLoad: async ({ context }) => {
    if (!context.authSession) {
      throw redirect({ to: '/signin', statusCode: 302 })
    }

    const userData: GetUserResponse = await context.queryClient.fetchQuery(
      authQueries.user(),
    )

    if (!userData.isAuthenticated) {
      throw redirect({ to: '/signin', statusCode: 302 })
    }

    return { user: userData.user }
  },
  component: DashboardLayout,
})

function DashboardLayout() {
  const { user } = Route.useRouteContext()
  const matchRoute = useMatchRoute()

  // Detect if we're inside a repo route to switch sidebar context
  const repoMatch = matchRoute({
    to: '/dashboard/repos/$repoId',
    fuzzy: true,
  })
  const repoId = repoMatch
    ? (repoMatch as { repoId: string }).repoId
    : null

  const navItems = repoId
    ? getRepoNavItems(repoId)
    : getAccountNavItems()

  return (
    <>
      <TopBar user={user} />
      <div className="pt-12">
        <OverlaySidebar navItems={navItems}>
          <Outlet />
        </OverlaySidebar>
      </div>
    </>
  )
}
