import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { repoQueries, statsQueries } from '@/services/queries'
import { SecurityHero } from '@/components/dashboard/security-hero'
import { TopIssues } from '@/components/dashboard/top-issues'
import { SecurityCategories } from '@/components/dashboard/security-categories'

export const Route = createFileRoute('/dashboard/repos/$repoId/')({
  component: SecurityDashboardPage,
})

function SecurityDashboardPage() {
  const { repoId } = Route.useParams()
  const { data: repo } = useQuery(repoQueries.detail(repoId))
  const { data: stats, isLoading } = useQuery(
    statsQueries.securityDashboard(repoId),
  )

  if (isLoading) {
    return (
      <div className="p-6 text-muted-foreground">
        Loading security dashboard...
      </div>
    )
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold">Security Dashboard</h1>
        {repo && (
          <p className="text-muted-foreground text-sm mt-0.5">{repo.name}</p>
        )}
      </div>

      {/* Hero: posture, stat cards, distribution bar */}
      <SecurityHero stats={stats} repoId={repoId} />

      {/* Top Issues */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Top Issues</h2>
        <TopIssues repoId={repoId} />
      </section>

      {/* By Category */}
      <section>
        <h2 className="text-lg font-semibold mb-4">By Category</h2>
        <SecurityCategories
          breakdown={stats?.breakdown}
          repoId={repoId}
        />
      </section>
    </div>
  )
}
