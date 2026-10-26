import { createFileRoute, Outlet } from '@tanstack/react-router'

export const Route = createFileRoute(
  '/dashboard/repos/$repoId/security',
)({
  component: SecurityLayout,
})

function SecurityLayout() {
  return <Outlet />
}
