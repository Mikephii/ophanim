import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { IconArrowLeft, IconShield, IconClipboardCheck, IconFunction, IconAlertTriangle } from '@tabler/icons-react'
import { functionQueries, dismissedQueries } from '@/services/queries'
import { SECURITY_FLAG_LABELS } from '@ophan/core/schemas'
import { SECURITY_EXPLAINERS } from '@/data/security-explainers'
import {
  SEVERITY_VARIANT,
  CONFIDENCE_LABEL,
} from '@/components/dashboard/severity-tags'
import {
  OpenInEditorBlock,
  FilePathDisplay,
} from '@/components/dashboard/function-ref'
import { IssueDismiss } from '@/components/dashboard/issue-dismiss'
import { toFileLine } from '@/services/api/line-utils'

export const Route = createFileRoute(
  '/dashboard/repos/$repoId/fn/$contentHash',
)({
  component: FunctionDetailPage,
})

function FunctionDetailPage() {
  const { repoId, contentHash } = Route.useParams()
  const navigate = useNavigate()
  const { data: fn, isLoading } = useQuery(
    functionQueries.detail(repoId, contentHash),
  )
  const { data: dismissedList } = useQuery(dismissedQueries.list(repoId))

  if (isLoading) {
    return (
      <div className="p-6 text-muted-foreground">Loading...</div>
    )
  }

  if (!fn) {
    return (
      <div className="p-6">
        <Link
          to="/dashboard/repos/$repoId/functions"
          params={{ repoId }}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-4"
        >
          <IconArrowLeft className="size-3" />
          Back to functions
        </Link>
        <p className="text-muted-foreground">Function not found.</p>
      </div>
    )
  }

  const { documentation, security, practices } = fn.analysis

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <Link
        to="/dashboard/repos/$repoId/functions"
        params={{ repoId }}
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-4"
      >
        <IconArrowLeft className="size-3" />
        Back to functions
      </Link>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-1.5 mb-1">
          <IconFunction className="size-7 shrink-0 self-center" />
          <h1 className="text-2xl font-semibold font-mono">
            {fn.function_name}()
          </h1>
          <Badge variant="secondary">{fn.language}</Badge>
          <Badge variant="outline">{fn.entity_type}</Badge>
        </div>
        <div className="flex items-center gap-3">
          <FilePathDisplay repoId={repoId} filePath={fn.file_path} />
          <OpenInEditorBlock repoId={repoId} filePath={fn.file_path} startLine={fn.start_line} />
        </div>
      </div>

      {/* Security Issues */}
      {security.securityFlags.length > 0 && (
        <Card className="mb-4 border-destructive/50">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <IconShield className="size-4 text-destructive" />
              Security Issues
            </CardTitle>
          </CardHeader>
          <CardContent>
            {security.issues && security.issues.length > 0 ? (
              <div className="space-y-4">
                {security.issues.map((issue, i) => {
                  const dismissed = dismissedList?.find(
                    (d) => d.content_hash === fn.content_hash && d.issue_index === i,
                  )
                  return (
                    <div
                      key={i}
                      className={`group border-l-2 border-destructive/50 pl-3 ${dismissed ? 'opacity-50' : ''}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Badge
                          variant={SEVERITY_VARIANT[issue.severity] ?? 'outline'}
                          className={`text-xs ${issue.flag in SECURITY_EXPLAINERS ? 'cursor-pointer hover:underline' : ''}`}
                          onClick={issue.flag in SECURITY_EXPLAINERS ? () => {
                            navigate({
                              to: '/dashboard/repos/$repoId/security/learn/$flag',
                              params: { repoId, flag: issue.flag },
                            })
                          } : undefined}
                        >
                          <IconAlertTriangle />
                          {SECURITY_FLAG_LABELS[issue.flag] ?? issue.flag}
                        </Badge>
                        <Badge
                          variant={SEVERITY_VARIANT[issue.severity] ?? 'outline'}
                          className="text-xs"
                        >
                          {issue.severity === 'info' ? 'alert' : issue.severity}
                        </Badge>
                        <Badge variant="outline" className="text-xs">
                          {CONFIDENCE_LABEL[issue.confidence] ?? 'likely'}
                        </Badge>
                        {issue.line > 0 && (
                          <span className="text-xs text-muted-foreground">
                            Line {toFileLine(fn.start_line, issue.line)}
                          </span>
                        )}
                        <IssueDismiss
                          repoId={repoId}
                          contentHash={fn.content_hash}
                          issueIndex={i}
                          flag={issue.flag}
                          dismissed={dismissed}
                        />
                      </div>
                      <p className={`text-sm font-medium ${dismissed ? 'line-through' : ''}`}>
                        {issue.title}
                      </p>
                      <p className="text-sm text-muted-foreground mt-1">
                        {issue.description}
                      </p>
                      {issue.explanation && (
                        <p className="text-sm text-muted-foreground/80 mt-1 italic">
                          {issue.explanation}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="flex gap-2 flex-wrap">
                {security.securityFlags.map((flag) => (
                  <Badge key={flag} variant="destructive">
                    {SECURITY_FLAG_LABELS[flag] ?? flag}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Practice Violations */}
      {practices.violations.length > 0 && (
        <Card className="mb-4 border-amber-500/50">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <IconClipboardCheck className="size-4 text-amber-500" />
              Practice Violations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {practices.violations.map((v, i) => (
                <div key={i} className="border-l-2 border-amber-500/50 pl-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className="text-xs border-amber-500/50 text-amber-600 dark:text-amber-400">
                      {v.flag}
                    </Badge>
                    <Badge
                      variant={SEVERITY_VARIANT[v.severity] ?? 'outline'}
                      className="text-xs"
                    >
                      {v.severity === 'info' ? 'alert' : v.severity}
                    </Badge>
                    {v.line > 0 && (
                      <span className="text-xs text-muted-foreground">
                        Line {toFileLine(fn.start_line, v.line)}
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-medium">{v.title}</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {v.description}
                  </p>
                  {v.explanation && (
                    <p className="text-sm text-muted-foreground/80 mt-1 italic">
                      {v.explanation}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Description */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Description</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {documentation.description || 'No description available.'}
          </p>
        </CardContent>
      </Card>

      {/* Parameters */}
      {documentation.params.length > 0 && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Parameters</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {documentation.params.map((p, i) => (
                <div key={i} className="flex items-start gap-3 text-sm">
                  <code className="font-mono font-medium text-primary shrink-0">
                    {p.name}
                  </code>
                  <span className="text-muted-foreground shrink-0">
                    {p.type}
                  </span>
                  <span>{p.description}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Returns */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Returns</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 text-sm">
            <span className="text-muted-foreground shrink-0">
              {documentation.returns.type}
            </span>
            <span>{documentation.returns.description}</span>
          </div>
        </CardContent>
      </Card>

      {/* Data Tags */}
      {security.dataTags.length > 0 && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">Data Tags</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2 flex-wrap">
              {security.dataTags.map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Metadata */}
      <div className="text-xs text-muted-foreground mt-6">
        Content hash: <code className="font-mono">{fn.content_hash}</code>
      </div>
    </div>
  )
}
