import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { architectureQueries } from '@/services/queries'


export const Route = createFileRoute(
  '/dashboard/repos/$repoId/architecture/other',
)({
  component: OtherSubsystemsPage,
})

function OtherSubsystemsPage() {
  const { repoId } = Route.useParams()
  const { data: hierarchy, isLoading } = useQuery(
    architectureQueries.hierarchy(repoId),
  )

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">Loading...</div>
  }

  // Collect grouped community IDs so we can find ungrouped ones
  const groupedIds = new Set(
    hierarchy?.groups.flatMap((g) =>
      g.l1Communities.map((c) => c.community_id),
    ) ?? [],
  )
  const ungrouped =
    hierarchy?.l1.filter((s) => !groupedIds.has(s.community_id)) ?? []

  return (
    <div>
      {/* Breadcrumbs */}
      <nav className="text-sm text-muted-foreground mb-4 flex items-center gap-1.5">
        <Link
          to="/dashboard/repos/$repoId/architecture"
          params={{ repoId }}
          className="hover:text-foreground"
        >
          Overview
        </Link>
        <span>/</span>
        <span className="text-foreground">Other Subsystems</span>
      </nav>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Other Subsystems</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {ungrouped.length} subsystem{ungrouped.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Description */}
      <div className="prose prose-sm dark:prose-invert max-w-none mb-8">
        <p>
          These subsystems were not grouped into a major system category during
          architecture analysis. They may represent standalone utilities,
          smaller features, or components whose relationships to the larger
          systems are less pronounced.
        </p>
      </div>

      {/* Ungrouped community cards */}
      {ungrouped.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {ungrouped.map((community) => (
            <Link
              key={community.community_id}
              to="/dashboard/repos/$repoId/architecture/$communityId"
              params={{ repoId, communityId: community.community_id }}
              className="block rounded-lg border p-4 hover:border-primary/50 transition-colors"
            >
              <div className="font-medium text-sm">
                {community.summary.title}
              </div>
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                {getExcerpt(community.summary.documentation)}
              </p>
            </Link>
          ))}
        </div>
      )}

      {ungrouped.length === 0 && (
        <p className="text-muted-foreground text-sm">
          All subsystems have been categorized into groups.
        </p>
      )}
    </div>
  )
}

function getExcerpt(markdown: string, maxLength = 120): string {
  const lines = markdown.split('\n').filter((l) => l.trim().length > 0)
  const first = lines[0] ?? ''
  const clean = first.replace(/^#+\s*/, '')
  return clean.length > maxLength
    ? clean.slice(0, maxLength - 3) + '...'
    : clean
}
