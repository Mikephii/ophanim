import { createFileRoute, Outlet } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { SidebarProvider } from '@/components/ui/sidebar'
import { ArchDocsSidebar } from '@/components/dashboard/arch-docs-sidebar'
import { architectureQueries } from '@/services/queries'

export const Route = createFileRoute(
  '/dashboard/repos/$repoId/architecture',
)({
  component: ArchitectureLayout,
})

function ArchitectureLayout() {
  const { repoId } = Route.useParams()
  const { data: hierarchy } = useQuery(
    architectureQueries.hierarchy(repoId),
  )

  return (
    <SidebarProvider defaultOpen={true}>
      <div className="flex w-full min-h-[calc(100vh-7rem)]">
        <ArchDocsSidebar hierarchy={hierarchy} repoId={repoId} />
        <main className="flex-1 overflow-auto">
          <div className="mx-auto max-w-5xl px-8 py-6">
            <Outlet />
          </div>
        </main>
      </div>
    </SidebarProvider>
  )
}
