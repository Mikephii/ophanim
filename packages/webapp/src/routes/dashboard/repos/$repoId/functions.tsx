import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from '@/components/ui/card'
import {
  IconShield,
  IconCode,
  IconSearch,
  IconFilter,
  IconChevronLeft,
  IconChevronRight,
} from '@tabler/icons-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { repoQueries, functionQueries, statsQueries } from '@/services/queries'
import { SECURITY_FLAG_LABELS } from '@ophan/core/schemas'
import { FunctionRef, OpenInEditorButton } from '@/components/dashboard/function-ref'

const PAGE_SIZE = 25

export const Route = createFileRoute('/dashboard/repos/$repoId/functions')({
  component: FunctionsPage,
})

function FunctionsPage() {
  const { repoId } = Route.useParams()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [securityOnly, setSecurityOnly] = useState(false)
  const [selectedLang, setSelectedLang] = useState<string>('')
  const [page, setPage] = useState(0)

  const { data: repo } = useQuery(repoQueries.detail(repoId))
  const { data: stats } = useQuery(statsQueries.overview(repoId))

  const { data: fnData, isLoading: functionsLoading } = useQuery(
    functionQueries.list(repoId, {
      securityOnly,
      language: selectedLang || undefined,
      search: search || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
  )

  const functions = fnData?.data ?? []
  const total = fnData?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)

  const languages = stats?.languages ?? []

  if (!repo) {
    return (
      <div className="p-6 text-muted-foreground">
        Repository not found.
      </div>
    )
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Functions</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          {total} functions analyzed in {repo.name}
        </p>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <IconCode className="size-3" />
              Functions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{stats?.functionCount ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <IconShield className="size-3" />
              Security Issues
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-destructive">
              {stats?.securityIssueCount ?? 0}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Languages</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-1.5 flex-wrap">
              {languages.map((lang) => (
                <Badge key={lang} variant="secondary">
                  {lang}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search functions or files..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(0)
            }}
            className="pl-9"
          />
        </div>
        <Button
          variant={securityOnly ? 'default' : 'outline'}
          size="sm"
          onClick={() => {
            setSecurityOnly(!securityOnly)
            setPage(0)
          }}
        >
          <IconFilter className="size-3" />
          Security issues only
        </Button>
        {languages.length > 1 && (
          <Select
            value={selectedLang}
            onValueChange={(value) => {
              setSelectedLang(value === 'all' ? '' : value)
              setPage(0)
            }}
          >
            <SelectTrigger size="sm">
              <SelectValue placeholder="All languages" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="all">All languages</SelectItem>
              {languages.map((lang) => (
                <SelectItem key={lang} value={lang}>
                  {lang}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Function cards */}
      {functionsLoading ? (
        <div className="text-muted-foreground py-8 text-center">
          Loading functions...
        </div>
      ) : functions.length === 0 ? (
        <div className="text-muted-foreground py-8 text-center">
          {securityOnly
            ? 'No functions with security issues found.'
            : 'No functions found matching your filters.'}
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {functions.map((fn) => {
              const hasFlags = fn.analysis.security.securityFlags.length > 0

              return (
                <div
                  key={fn.content_hash}
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    navigate({
                      to: '/dashboard/repos/$repoId/fn/$contentHash',
                      params: { repoId, contentHash: fn.content_hash },
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      navigate({
                        to: '/dashboard/repos/$repoId/fn/$contentHash',
                        params: { repoId, contentHash: fn.content_hash },
                      })
                    }
                  }}
                  className={`rounded-lg border bg-card p-4 transition-colors hover:bg-muted ${hasFlags ? 'border-l-4 border-l-amber-500' : ''}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      {/* Top line: function name + language */}
                      <div className="flex items-center gap-2 min-w-0">
                        <FunctionRef
                          functionName={fn.function_name}
                          contentHash={fn.content_hash}
                          repoId={repoId}
                          disableLink
                        />
                        <Badge variant="secondary" className="text-xs shrink-0">
                          {fn.language}
                        </Badge>
                      </div>

                      {/* File path */}
                      <p className="text-xs text-muted-foreground">
                        {fn.file_path}
                      </p>

                      {/* Description */}
                      {fn.analysis.documentation.description && (
                        <p className="text-sm text-muted-foreground">
                          {fn.analysis.documentation.description}
                        </p>
                      )}

                      {/* Security flags */}
                      {hasFlags && (
                        <div className="flex gap-1.5 flex-wrap pt-1">
                          {fn.analysis.security.securityFlags.map((flag) => (
                            <Badge
                              key={flag}
                              variant="destructive"
                              className="text-xs"
                            >
                              {SECURITY_FLAG_LABELS[flag] ?? flag}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    {fn.file_path && (
                      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                        <OpenInEditorButton repoId={repoId} filePath={fn.file_path} startLine={fn.start_line} />
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-muted-foreground">
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
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
