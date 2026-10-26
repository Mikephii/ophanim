import { Link } from '@tanstack/react-router'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import type { CommunitySummary } from '@/services/api/types'

function getExcerpt(markdown: string, maxLength = 150): string {
  const lines = markdown.split('\n').filter((l) => l.trim().length > 0)
  const first = lines.find((l) => !l.trim().startsWith('#')) ?? ''
  const clean = first.trim()
  return clean.length > maxLength
    ? clean.slice(0, maxLength - 3) + '...'
    : clean
}

export function CommunityCard({
  summary,
  repoId,
}: {
  summary: CommunitySummary
  repoId: string
}) {
  const excerpt = getExcerpt(summary.summary.documentation)

  return (
    <Link
      to="/dashboard/repos/$repoId/architecture/$communityId"
      params={{ repoId, communityId: summary.community_id }}
      className="block h-full hover:ring-2 hover:ring-ring rounded-xl transition-shadow cursor-pointer"
    >
      <Card className="h-full">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {summary.summary.title}
          </CardTitle>
          <CardDescription className="text-sm line-clamp-2">
            {excerpt}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            {summary.summary.meta.complexity} complexity
          </p>
        </CardContent>
      </Card>
    </Link>
  )
}
