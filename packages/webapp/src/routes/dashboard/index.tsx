import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { IconFolder, IconShield, IconCode, IconTerminal2 } from '@tabler/icons-react'
import { dashboardQueries, repoQueries } from '@/services/queries'

export const Route = createFileRoute('/dashboard/')({
  component: ProjectsPage,
})

function ProjectsPage() {
  const { data: repos, isLoading } = useQuery(repoQueries.list())
  const { data: stats } = useQuery(dashboardQueries.stats())

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Projects</h1>
        <p className="text-muted-foreground mt-1">
          {stats
            ? `${stats.repoCount} repositories, ${stats.functionCount} functions analyzed`
            : 'Your synced repositories'}
        </p>
      </div>

      {isLoading ? (
        <div className="text-muted-foreground">Loading...</div>
      ) : !repos || repos.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <IconTerminal2 className="size-5" />
              No repositories synced yet
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm mb-4">
              Analyze and sync a repository from your terminal to see it here.
            </p>
            <pre className="bg-muted rounded-md p-4 text-sm">
              <code>
                {`ophan analyze --path /path/to/repo\nophan sync --path /path/to/repo`}
              </code>
            </pre>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          {repos.map((repo) => (
            <Link
              key={repo.id}
              to="/dashboard/repos/$repoId"
              params={{ repoId: repo.id }}
              className="group"
            >
              <Card className="transition-colors hover:border-primary/50 h-full">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="size-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                        <IconFolder className="size-4 text-muted-foreground" />
                      </div>
                      <div className="min-w-0">
                        <CardTitle className="text-lg truncate">
                          {repo.name}
                        </CardTitle>
                        {repo.remote_url && (
                          <p className="text-muted-foreground text-xs truncate mt-0.5">
                            {repo.remote_url}
                          </p>
                        )}
                      </div>
                    </div>
                    {repo.securityIssueCount > 0 && (
                      <Badge variant="destructive" className="text-xs shrink-0 ml-2">
                        {repo.securityIssueCount} issues
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-5 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <IconCode className="size-3.5" />
                      {repo.functionCount} functions
                    </span>
                    <span className="flex items-center gap-1.5">
                      <IconShield className="size-3.5" />
                      {repo.securityIssueCount} issues
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-3">
                    Updated {new Date(repo.updated_at).toLocaleDateString()}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
