import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { architectureQueries } from '@/services/queries'
import { MarkdownRenderer } from '@/components/dashboard/markdown-renderer'
import { MetaBadges } from '@/components/dashboard/meta-badges'
import { DocsToc } from '@/components/dashboard/docs-toc'
import { ConcernCard } from '@/components/dashboard/concern-card'
import { FunctionRef } from '@/components/dashboard/function-ref'

export const Route = createFileRoute(
  '/dashboard/repos/$repoId/architecture/$communityId',
)({
  component: CommunityDetailPage,
})

function CommunityDetailPage() {
  const { repoId, communityId } = Route.useParams()
  const { data: community, isLoading } = useQuery(
    architectureQueries.communityDetail(repoId, communityId),
  )

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">Loading...</div>
  }

  if (!community) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Community not found.</p>
      </div>
    )
  }

  const documentation = community.summary.documentation

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
          {community.parentGroup && (
            <>
              <span>/</span>
              <Link
                to="/dashboard/repos/$repoId/architecture/groups/$groupId"
                params={{ repoId, groupId: community.parentGroup.groupId }}
                className="hover:text-foreground"
              >
                {community.parentGroup.title}
              </Link>
            </>
          )}
          <span>/</span>
          <span className="text-foreground">{community.summary.title}</span>
        </nav>

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-semibold">
            {community.summary.title}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {community.memberCount} functions
          </p>
        </div>

        {/* Meta badges */}
        <div className="mb-6">
          <MetaBadges meta={community.summary.meta} />
        </div>

        {/* Documentation */}
        <div className="mb-8">
          <MarkdownRenderer content={documentation} />
        </div>

        {/* Related Subsystems */}
        {community.relatedCommunities.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-4">Related Subsystems</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {community.relatedCommunities.map((rel) => (
                <Link
                  key={rel.communityId}
                  to="/dashboard/repos/$repoId/architecture/$communityId"
                  params={{ repoId, communityId: rel.communityId }}
                  className="block rounded-lg border p-4 hover:border-primary/50 transition-colors"
                >
                  <div className="font-medium text-sm">{rel.title}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {rel.edgeCount} connection{rel.edgeCount !== 1 ? 's' : ''}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Cross-Cutting Concerns */}
        {community.relatedConcerns.length > 0 && (
          <div className="mb-8">
            <h2 className="text-lg font-semibold mb-4">Cross-Cutting Concerns</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {community.relatedConcerns.map((concern) => (
                <ConcernCard
                  key={concern.community_id}
                  concern={concern}
                  repoId={repoId}
                />
              ))}
            </div>
          </div>
        )}

        {/* Member functions */}
        {community.members.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold mb-4">Functions</h2>
            <div className="space-y-2">
              {community.members.map((member) => (
                <div
                  key={member.content_hash}
                  className="rounded-lg border bg-card p-3"
                >
                  <div className="space-y-1">
                    <FunctionRef
                      functionName={member.function_name}
                      contentHash={member.content_hash}
                      repoId={repoId}
                      filePath={member.file_path}
                    />
                    <p className="text-xs text-muted-foreground">
                      {member.file_path}
                    </p>
                    {member.description && (
                      <p className="text-sm text-muted-foreground">
                        {member.description}
                      </p>
                    )}
                  </div>
                </div>
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
