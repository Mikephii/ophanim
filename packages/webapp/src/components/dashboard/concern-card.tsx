import { Link } from '@tanstack/react-router'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { CrossCuttingConcern } from '@/services/api/types'

export function ConcernCard({
  concern,
  repoId,
}: {
  concern: CrossCuttingConcern
  repoId: string
}) {
  const { summary } = concern
  const isSecurityConcern = summary.concernType === 'security'

  return (
    <Link
      to="/dashboard/repos/$repoId/architecture/concerns/$concernId"
      params={{ repoId, concernId: concern.community_id }}
      className="block h-full hover:ring-2 hover:ring-ring rounded-xl transition-shadow cursor-pointer"
    >
      <Card className="h-full">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2 mb-1">
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
          <CardTitle className="text-base">{summary.title}</CardTitle>
          <CardDescription className="text-sm line-clamp-2">
            {summary.affectedCommunities
              .map((c) => c.communityTitle)
              .join(', ')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            {summary.bridgeFunctions.length} bridge function
            {summary.bridgeFunctions.length !== 1 ? 's' : ''} across{' '}
            {summary.affectedCommunities.length} subsystem
            {summary.affectedCommunities.length !== 1 ? 's' : ''}
          </p>
        </CardContent>
      </Card>
    </Link>
  )
}
