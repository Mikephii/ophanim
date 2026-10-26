import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { IconGitBranch, IconGitCommit } from '@tabler/icons-react'
import { architectureQueries, repoQueries } from '@/services/queries'
import { MarkdownRenderer } from '@/components/dashboard/markdown-renderer'
import { MetaBadges } from '@/components/dashboard/meta-badges'
import { DocsToc } from '@/components/dashboard/docs-toc'

function relativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 30) return `${diffDays}d ago`
  const diffMonths = Math.floor(diffDays / 30)
  return `${diffMonths}mo ago`
}

export const Route = createFileRoute(
  '/dashboard/repos/$repoId/architecture/',
)({
  component: ArchitectureOverviewPage,
})

function ArchitectureOverviewPage() {
  const { repoId } = Route.useParams()
  const { data: hierarchy, isLoading } = useQuery(
    architectureQueries.hierarchy(repoId),
  )
  const { data: repo } = useQuery(repoQueries.detail(repoId))

  if (isLoading) {
    return (
      <div className="p-6 text-muted-foreground">Loading architecture...</div>
    )
  }

  if (!hierarchy || (hierarchy.l1.length === 0 && !hierarchy.l3)) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-semibold mb-4">Architecture</h1>
        <div className="text-muted-foreground py-8 text-center">
          <p className="mb-2">No architecture documentation yet.</p>
          <p className="text-sm">
            Run{' '}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
              ophan graph --summarize
            </code>{' '}
            then{' '}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
              ophan sync
            </code>{' '}
            to generate and sync architecture docs.
          </p>
        </div>
      </div>
    )
  }

  const documentation = hierarchy.l3?.summary.documentation ?? ''

  return (
    <div className="flex gap-8">
      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-semibold">
            {hierarchy.l3?.summary.title ?? 'Architecture Overview'}
          </h1>
          {repo?.docs_branch && (
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <IconGitBranch className="size-3" />
              Generated from <code className="font-mono">{repo.docs_branch}</code>
              {repo.last_docs_sync_commit && (
                <>
                  <span className="mx-0.5">&middot;</span>
                  <IconGitCommit className="size-3" />
                  <code className="font-mono">{repo.last_docs_sync_commit.slice(0, 7)}</code>
                </>
              )}
              {repo.last_docs_sync_at && (
                <>
                  <span className="mx-0.5">&middot;</span>
                  {relativeTime(repo.last_docs_sync_at)}
                </>
              )}
            </p>
          )}
        </div>

        {/* Meta badges */}
        {hierarchy.l3 && (
          <div className="mb-6">
            <MetaBadges meta={hierarchy.l3.summary.meta} />
          </div>
        )}

        {/* L3 Documentation */}
        {documentation && (
          <div className="mb-8">
            <MarkdownRenderer content={documentation} />
          </div>
        )}

        {/* Quick nav -- systems overview */}
        {hierarchy.groups.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-4">Major Systems</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {hierarchy.groups.map((group) => (
                <Link
                  key={group.groupId}
                  to="/dashboard/repos/$repoId/architecture/groups/$groupId"
                  params={{ repoId, groupId: group.groupId }}
                  className="block rounded-lg border p-4 hover:border-primary/50 transition-colors"
                >
                  <div className="font-medium text-sm">{group.title}</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {group.l1Communities.length} subsystem
                    {group.l1Communities.length !== 1 ? 's' : ''}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Cross-cutting concerns quick nav */}
        {hierarchy.crossCutting.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold mb-4">
              Cross-Cutting Concerns
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {hierarchy.crossCutting.map((concern) => (
                <Link
                  key={concern.community_id}
                  to="/dashboard/repos/$repoId/architecture/concerns/$concernId"
                  params={{ repoId, concernId: concern.community_id }}
                  className="block rounded-lg border p-4 hover:border-primary/50 transition-colors"
                >
                  <div className="font-medium text-sm">
                    {concern.summary.title}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {concern.summary.affectedCommunities.length} subsystem
                    {concern.summary.affectedCommunities.length !== 1
                      ? 's'
                      : ''}{' '}
                    affected
                  </p>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Table of Contents */}
      {documentation && <DocsToc content={documentation} />}
    </div>
  )
}
