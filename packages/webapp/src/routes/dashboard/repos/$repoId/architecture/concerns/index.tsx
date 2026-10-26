import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { architectureQueries } from '@/services/queries'
import { ConcernCard } from '@/components/dashboard/concern-card'

export const Route = createFileRoute(
  '/dashboard/repos/$repoId/architecture/concerns/',
)({
  component: ConcernsOverviewPage,
})

function ConcernsOverviewPage() {
  const { repoId } = Route.useParams()
  const { data: hierarchy, isLoading } = useQuery(
    architectureQueries.hierarchy(repoId),
  )

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">Loading...</div>
  }

  const concerns = hierarchy?.crossCutting ?? []

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Cross-Cutting Concerns</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {concerns.length} concern{concerns.length !== 1 ? 's' : ''} detected
        </p>
      </div>

      {/* Description */}
      <div className="prose prose-sm dark:prose-invert max-w-none mb-8">
        <p>
          Cross-cutting concerns are patterns that span multiple subsystems —
          security policies, data flows, and shared conventions that affect the
          codebase broadly rather than belonging to a single component.
        </p>
      </div>

      {/* Concern cards */}
      {concerns.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {concerns.map((concern) => (
            <ConcernCard
              key={concern.community_id}
              concern={concern}
              repoId={repoId}
            />
          ))}
        </div>
      )}

      {concerns.length === 0 && (
        <p className="text-muted-foreground text-sm">
          No cross-cutting concerns have been detected yet.
        </p>
      )}
    </div>
  )
}
