import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  IconChevronLeft,
  IconChevronRight,
  IconEyeOff,
} from '@tabler/icons-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { securityQueries, dismissedQueries } from '@/services/queries'
import {
  SECURITY_FLAG_LABELS,
  KNOWN_SECURITY_FLAGS,
} from '@ophan/core/schemas'
import { IssueCard } from '@/components/dashboard/issue-card'
import { flattenIssues } from '@/services/api/security-utils'

const PAGE_SIZE = 25

type SearchParams = {
  flag?: string
  severity?: string
}

export const Route = createFileRoute(
  '/dashboard/repos/$repoId/security/issues',
)({
  component: SecurityIssuesPage,
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    flag: typeof search.flag === 'string' ? search.flag : undefined,
    severity: typeof search.severity === 'string' ? search.severity : undefined,
  }),
})

function SecurityIssuesPage() {
  const { repoId } = Route.useParams()
  const { flag: flagFromUrl, severity: severityFromUrl } = Route.useSearch()
  const [selectedFlag, setSelectedFlag] = useState<string>(flagFromUrl ?? '')
  const [selectedSeverity, setSelectedSeverity] = useState<string>(severityFromUrl ?? '')
  const [page, setPage] = useState(0)
  const [showDismissed, setShowDismissed] = useState(false)

  const { data, isLoading } = useQuery(
    securityQueries.issues(repoId, {
      flag: selectedFlag || undefined,
      severity: selectedSeverity || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
  )
  const { data: dismissedList } = useQuery(dismissedQueries.list(repoId))
  const dismissedSet = new Set(
    (dismissedList ?? []).map((d) => `${d.content_hash}:${d.issue_index}`),
  )

  const functions = data?.data ?? []
  const total = data?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  const flagOptions = [...KNOWN_SECURITY_FLAGS]

  // Flatten to one card per issue, sorted by priority
  const allIssues = flattenIssues(functions, selectedFlag || undefined)
  const visibleIssues = showDismissed
    ? allIssues
    : allIssues.filter(
        (item) =>
          !dismissedSet.has(`${item.fn.content_hash}:${item.issueIndex}`),
      )

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Security Issues</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          {total} function{total !== 1 ? 's' : ''} with security issues
        </p>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Select
          value={selectedFlag || 'all'}
          onValueChange={(value) => {
            setSelectedFlag(value === 'all' ? '' : value)
            setPage(0)
          }}
        >
          <SelectTrigger size="sm">
            <SelectValue placeholder="All vulnerability types" />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="all">All vulnerability types</SelectItem>
            {flagOptions.map((flag) => (
              <SelectItem key={flag} value={flag}>
                {SECURITY_FLAG_LABELS[flag] ?? flag}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={selectedSeverity || 'all'}
          onValueChange={(value) => {
            setSelectedSeverity(value === 'all' ? '' : value)
            setPage(0)
          }}
        >
          <SelectTrigger size="sm">
            <SelectValue placeholder="All severities" />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="all">All severities</SelectItem>
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="warning">Warning</SelectItem>
            <SelectItem value="info">Alert</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant={showDismissed ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowDismissed(!showDismissed)}
        >
          <IconEyeOff className="size-3" />
          Show dismissed
        </Button>
      </div>

      {/* Issues */}
      {isLoading ? (
        <div className="text-muted-foreground py-8 text-center">
          Loading issues...
        </div>
      ) : visibleIssues.length === 0 ? (
        <div className="text-muted-foreground py-8 text-center">
          {selectedFlag || selectedSeverity
            ? 'No issues found matching your filters.'
            : 'No security issues found.'}
        </div>
      ) : (
        <>
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
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-muted-foreground">
                Page {page + 1} of {totalPages}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  <IconChevronLeft className="size-4" />
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                  <IconChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
