import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { architectureQueries } from '@/services/queries'
import { MarkdownRenderer } from '@/components/dashboard/markdown-renderer'
import { DocsToc } from '@/components/dashboard/docs-toc'
import { FunctionRef } from '@/components/dashboard/function-ref'

export const Route = createFileRoute(
  '/dashboard/repos/$repoId/architecture/concerns/$concernId',
)({
  component: ConcernDetailPage,
})

function ConcernDetailPage() {
  const { repoId, concernId } = Route.useParams()
  const { data: concern, isLoading } = useQuery(
    architectureQueries.concernDetail(repoId, concernId),
  )

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">Loading...</div>
  }

  if (!concern) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Concern not found.</p>
      </div>
    )
  }

  const { summary } = concern
  const isSecurityConcern = summary.concernType === 'security'
  const documentation = summary.documentation

  return (
    <div className="flex gap-8">
      <div className="flex-1 min-w-0">
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
          <span className="text-foreground">{summary.title}</span>
        </nav>

        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <Badge variant={isSecurityConcern ? 'destructive' : 'secondary'}>
              {isSecurityConcern ? 'Security' : 'Data Flow'}
            </Badge>
            <Badge
              variant="outline"
              className={
                summary.severity === 'high'
                  ? 'border-red-500 text-red-600'
                  : summary.severity === 'medium'
                    ? 'border-yellow-500 text-yellow-600'
                    : 'border-green-500 text-green-600'
              }
            >
              {summary.severity} severity
            </Badge>
          </div>
          <h1 className="text-2xl font-semibold">{summary.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {summary.affectedCommunities.length} subsystem
            {summary.affectedCommunities.length !== 1 ? 's' : ''} affected
          </p>
        </div>

        {/* Documentation */}
        <div className="mb-8">
          <MarkdownRenderer content={documentation} />
        </div>

        {/* Bridge Functions */}
        {summary.bridgeFunctions.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-4">Bridge Functions</h2>
            <div className="space-y-2">
              {summary.bridgeFunctions.map((fn) => (
                <div
                  key={fn.contentHash}
                  className="rounded-lg border bg-card p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <FunctionRef
                        functionName={fn.functionName}
                        contentHash={fn.contentHash}
                        repoId={repoId}
                      />
                      <p className="text-xs text-muted-foreground">
                        {summary.affectedCommunities.find(
                          (c) => c.communityId === fn.communityId,
                        )?.communityTitle ?? fn.communityId}
                      </p>
                    </div>
                    <span className="text-sm text-muted-foreground tabular-nums shrink-0">
                      {fn.centrality.toFixed(3)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Affected Communities */}
        {summary.affectedCommunities.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold mb-4">Affected Subsystems</h2>
            <div className="flex flex-wrap gap-2">
              {summary.affectedCommunities.map((c) => (
                <Link
                  key={c.communityId}
                  to="/dashboard/repos/$repoId/architecture/$communityId"
                  params={{ repoId, communityId: c.communityId }}
                  className="inline-block"
                >
                  <Badge
                    variant="outline"
                    className="hover:bg-accent cursor-pointer"
                  >
                    {c.communityTitle}
                  </Badge>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Table of Contents */}
      <DocsToc content={documentation} />
    </div>
  )
}
