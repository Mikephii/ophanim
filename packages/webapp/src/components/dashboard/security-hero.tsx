import { Link } from '@tanstack/react-router'
import {
  IconShieldCheck,
  IconAlertTriangle,
  IconFlame,
  IconCode,
} from '@tabler/icons-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from '@/components/ui/card'
import {
  SECURITY_FLAG_LABELS,
  SECURITY_FLAG_META,
} from '@ophan/core/schemas'
import type { SecurityDashboardStats, FlagBreakdownEntry } from '@/services/api/types'

const TIER_COLORS: Record<number, string> = {
  1: 'bg-red-500',
  2: 'bg-amber-500',
  3: 'bg-yellow-400',
  4: 'bg-gray-400',
}

function PostureBadge({ posture }: { posture: SecurityDashboardStats['posture'] }) {
  if (posture === 'critical') {
    return (
      <div className="flex items-center gap-2 text-destructive">
        <IconFlame className="size-5" />
        <span className="text-lg font-semibold">Critical Issues Found</span>
      </div>
    )
  }
  if (posture === 'warning') {
    return (
      <div className="flex items-center gap-2 text-amber-500">
        <IconAlertTriangle className="size-5" />
        <span className="text-lg font-semibold">Needs Attention</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
      <IconShieldCheck className="size-5" />
      <span className="text-lg font-semibold">No Issues Found</span>
    </div>
  )
}

function DistributionBar({
  breakdown,
  repoId,
}: {
  breakdown: Record<string, FlagBreakdownEntry>
  repoId: string
}) {
  const entries = Object.entries(breakdown).sort((a, b) => {
    const tierA = SECURITY_FLAG_META[a[0]]?.tier ?? 3
    const tierB = SECURITY_FLAG_META[b[0]]?.tier ?? 3
    if (tierA !== tierB) return tierA - tierB
    return b[1].count - a[1].count
  })

  const total = entries.reduce((sum, [, e]) => sum + e.count, 0)
  if (total === 0) return null

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground font-medium">Issue Distribution</p>
      <div className="flex h-3 rounded-full overflow-hidden gap-0.5">
        {entries.map(([flag, entry]) => {
          const tier = SECURITY_FLAG_META[flag]?.tier ?? 3
          const pct = (entry.count / total) * 100
          return (
            <Link
              key={flag}
              to="/dashboard/repos/$repoId/security/issues"
              params={{ repoId }}
              search={{ flag }}
              className={`${TIER_COLORS[tier]} hover:opacity-80 transition-opacity`}
              style={{ flexGrow: pct }}
              title={`${SECURITY_FLAG_LABELS[flag] ?? flag}: ${entry.count} issues`}
            />
          )
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {entries.map(([flag, entry]) => {
          const tier = SECURITY_FLAG_META[flag]?.tier ?? 3
          return (
            <div key={flag} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={`inline-block size-2 rounded-full ${TIER_COLORS[tier]}`} />
              <span>{SECURITY_FLAG_LABELS[flag] ?? flag}</span>
              <span className="font-medium text-foreground">{entry.count}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function SecurityHero({
  stats,
  repoId,
}: {
  stats: SecurityDashboardStats | undefined
  repoId: string
}) {
  if (!stats) return null

  return (
    <div className="space-y-6">
      {/* Posture + Stats */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <PostureBadge posture={stats.posture} />
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <IconFlame className="size-3" />
              Critical
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-destructive">
              {stats.criticalCount}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              high confidence errors
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <IconAlertTriangle className="size-3" />
              Errors
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-orange-500">
              {stats.errorCount}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <IconAlertTriangle className="size-3" />
              Warnings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-amber-500">
              {stats.warningCount}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <IconCode className="size-3" />
              Functions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{stats.totalFunctions}</p>
          </CardContent>
        </Card>
      </div>

      {/* Distribution Bar */}
      <DistributionBar breakdown={stats.breakdown} repoId={repoId} />
    </div>
  )
}
