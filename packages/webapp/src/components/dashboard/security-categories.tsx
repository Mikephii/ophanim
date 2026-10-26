import { Link } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  SECURITY_FLAG_LABELS,
  SECURITY_FLAG_META,
  SECURITY_TIER_LABELS,
  KNOWN_SECURITY_FLAGS,
} from '@ophan/core/schemas'
import type { FlagBreakdownEntry } from '@/services/api/types'

const TIER_DOT_COLORS: Record<number, string> = {
  1: 'bg-red-500',
  2: 'bg-amber-500',
  3: 'bg-yellow-400',
  4: 'bg-gray-400',
}

export function SecurityCategories({
  breakdown,
  repoId,
}: {
  breakdown: Record<string, FlagBreakdownEntry> | undefined
  repoId: string
}) {
  if (!breakdown) return null

  const entries = Object.entries(breakdown)
    .filter(([, e]) => e.count > 0)
    .sort((a, b) => {
      const tierA = SECURITY_FLAG_META[a[0]]?.tier ?? 3
      const tierB = SECURITY_FLAG_META[b[0]]?.tier ?? 3
      if (tierA !== tierB) return tierA - tierB
      return b[1].count - a[1].count
    })

  // Find flags with no issues for the "clean" line
  const allKnownFlags = [...KNOWN_SECURITY_FLAGS]
  const flagsWithIssues = new Set(entries.map(([f]) => f))
  const cleanFlags = allKnownFlags.filter((f) => !flagsWithIssues.has(f))

  if (entries.length === 0) {
    return (
      <div className="text-center py-4 text-muted-foreground text-sm">
        No security issues by category.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {entries.map(([flag, entry]) => {
          const tier = SECURITY_FLAG_META[flag]?.tier ?? 3
          const dotColor = TIER_DOT_COLORS[tier]

          return (
            <Link
              key={flag}
              to="/dashboard/repos/$repoId/security/issues"
              params={{ repoId }}
              search={{ flag }}
              className="block"
            >
              <Card className="hover:border-primary/50 transition-colors h-full">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`inline-block size-2.5 rounded-full ${dotColor}`} />
                      <span className="font-medium text-sm">
                        {SECURITY_FLAG_LABELS[flag] ?? flag}
                      </span>
                    </div>
                    <Badge variant="outline" className="text-xs">
                      {SECURITY_TIER_LABELS[tier]}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-baseline gap-2">
                    <span className="text-lg font-bold">{entry.count}</span>
                    <span className="text-xs text-muted-foreground">
                      issue{entry.count !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="flex gap-2 mt-1 text-xs text-muted-foreground">
                    {entry.errorCount > 0 && (
                      <span className="text-destructive">
                        {entry.errorCount} error{entry.errorCount !== 1 ? 's' : ''}
                      </span>
                    )}
                    {entry.warningCount > 0 && (
                      <span className="text-amber-500">
                        {entry.warningCount} warning{entry.warningCount !== 1 ? 's' : ''}
                      </span>
                    )}
                    {entry.infoCount > 0 && (
                      <span>{entry.infoCount} info</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          )
        })}
      </div>

      {/* Clean flags */}
      {cleanFlags.length > 0 && (
        <p className="text-xs text-muted-foreground">
          No issues:{' '}
          {cleanFlags
            .map((f) => SECURITY_FLAG_LABELS[f] ?? f)
            .join(', ')}
        </p>
      )}
    </div>
  )
}
