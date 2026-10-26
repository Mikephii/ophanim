import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { IconShieldCheck } from '@tabler/icons-react'
import { securityQueries, dismissedQueries } from '@/services/queries'
import { flattenIssues } from '@/services/api/security-utils'
import { IssueCard } from '@/components/dashboard/issue-card'

export function TopIssues({ repoId }: { repoId: string }) {
  // Fetch error-severity issues and general issues in parallel to ensure
  // critical items always appear even when sorted by flag_count server-side
  const { data: errorData, isLoading: errorLoading } = useQuery(
    securityQueries.issues(repoId, { severity: 'error', pageSize: 16 }),
  )
  const { data, isLoading } = useQuery(
    securityQueries.issues(repoId, { pageSize: 16 }),
  )
  const { data: dismissedList } = useQuery(dismissedQueries.list(repoId))
  const dismissedSet = new Set(
    (dismissedList ?? []).map((d) => `${d.content_hash}:${d.issue_index}`),
  )

  if (isLoading && errorLoading) {
    return <div className="text-muted-foreground text-sm">Loading issues...</div>
  }

  // Merge error-severity results with general results, deduplicate by content_hash
  const seen = new Set<string>()
  const merged = [...(errorData?.data ?? []), ...(data?.data ?? [])].filter((fn) => {
    if (seen.has(fn.content_hash)) return false
    seen.add(fn.content_hash)
    return true
  })

  // Flatten to individual issues sorted by priority, filter dismissed, take top 8
  const allIssues = flattenIssues(merged)
  const visibleIssues = allIssues
    .filter((item) => !dismissedSet.has(`${item.fn.content_hash}:${item.issueIndex}`))
    .slice(0, 8)

  if (visibleIssues.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <IconShieldCheck className="size-8 mx-auto mb-2 text-green-600 dark:text-green-400" />
        <p>No security issues found.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {visibleIssues.map((item) => {
        const isDismissed = dismissedSet.has(
          `${item.fn.content_hash}:${item.issueIndex}`,
        )
        const dismissed = dismissedList?.find(
          (d) =>
            d.content_hash === item.fn.content_hash &&
            d.issue_index === item.issueIndex,
        )

        return (
          <IssueCard
            key={`${item.fn.content_hash}:${item.issueIndex}`}
            repoId={repoId}
            fn={item.fn}
            issue={item.issue}
            issueIndex={item.issueIndex}
            isDismissed={isDismissed}
            dismissed={dismissed}
          />
        )
      })}

      {(data?.total ?? 0) > 8 && (
        <div className="text-center pt-2">
          <Link
            to="/dashboard/repos/$repoId/security/issues"
            params={{ repoId }}
            className="text-sm text-primary hover:underline"
          >
            View all {data?.total} issues &rarr;
          </Link>
        </div>
      )}
    </div>
  )
}
