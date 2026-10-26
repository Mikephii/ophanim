import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { architectureQueries } from '@/services/queries'
import { MarkdownRenderer } from '@/components/dashboard/markdown-renderer'
import { MetaBadges } from '@/components/dashboard/meta-badges'
import { DocsToc } from '@/components/dashboard/docs-toc'

export const Route = createFileRoute(
  '/dashboard/repos/$repoId/architecture/groups/$groupId',
)({
  component: GroupDetailPage,
})

function GroupDetailPage() {
  const { repoId, groupId } = Route.useParams()
  const { data: hierarchy, isLoading } = useQuery(
    architectureQueries.hierarchy(repoId),
  )

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">Loading...</div>
  }

  const group = hierarchy?.groups.find((g) => g.groupId === groupId)

  if (!group) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Group not found.</p>
      </div>
    )
  }

  const documentation = group.overview?.summary.documentation ?? ''

  return (
    <div className="flex gap-8">
      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-semibold">{group.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {group.l1Communities.length} subsystem
            {group.l1Communities.length !== 1 ? 's' : ''}
          </p>
        </div>

        {/* Meta badges */}
        {group.overview && (
          <div className="mb-6">
            <MetaBadges meta={group.overview.summary.meta} />
          </div>
        )}

        {/* Documentation */}
        {documentation && (
          <div className="mb-8">
            <MarkdownRenderer content={documentation} />
          </div>
        )}

        {/* Child subsystems */}
        <div>
          <h2 className="text-lg font-semibold mb-4">Subsystems</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.l1Communities.map((community) => (
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
        </div>
      </div>

      {/* Table of Contents */}
      {documentation && <DocsToc content={documentation} />}
    </div>
  )
}

function getExcerpt(markdown: string, maxLength = 120): string {
  const lines = markdown.split('\n').filter((l) => l.trim().length > 0)
  const first = lines.find((l) => !l.trim().startsWith('#')) ?? ''
  const clean = first.trim()
  return clean.length > maxLength
    ? clean.slice(0, maxLength - 3) + '...'
    : clean
}
