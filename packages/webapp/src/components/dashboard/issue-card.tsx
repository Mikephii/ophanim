import { useNavigate } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import { IconAlertTriangle } from '@tabler/icons-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { SECURITY_FLAG_LABELS } from '@ophan/core/schemas'
import { SECURITY_EXPLAINERS } from '@/data/security-explainers'
import {
  SEVERITY_VARIANT,
  SEVERITY_BORDER,
  SEVERITY_INFO,
  PRIORITY_VARIANT,
  PRIORITY_INFO,
  CONFIDENCE_LABEL,
} from '@/components/dashboard/severity-tags'
import { priorityScore, priorityLabel } from '@/services/api/security-utils'
import { FunctionRef, OpenInEditorButton } from '@/components/dashboard/function-ref'
import { IssueDismiss } from '@/components/dashboard/issue-dismiss'
import type { EnrichedFunction } from '@/services/api/types'
import type { DismissedIssue } from '@/services/api/types'

type IssueCardProps = {
  repoId: string
  fn: EnrichedFunction
  issue: EnrichedFunction['analysis']['security']['issues'][number]
  issueIndex: number
  isDismissed: boolean
  dismissed?: DismissedIssue
}

export function IssueCard({
  repoId,
  fn,
  issue,
  issueIndex,
  isDismissed,
  dismissed,
}: IssueCardProps) {
  const navigate = useNavigate()
  const score = priorityScore(issue.severity, issue.confidence)
  const pLabel = priorityLabel(score)
  const borderColor =
    SEVERITY_BORDER[issue.severity] ?? SEVERITY_BORDER.warning
  const sev = SEVERITY_INFO[issue.severity] ?? SEVERITY_INFO.warning
  const likelihood = CONFIDENCE_LABEL[issue.confidence] ?? 'likely'
  const flagLabel = SECURITY_FLAG_LABELS[issue.flag] ?? issue.flag

  return (
    <TooltipProvider>
    <div
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
      className={`group border-l-4 ${borderColor} rounded-lg border bg-card p-4 transition-colors hover:bg-muted ${isDismissed ? 'opacity-50' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          {/* Badges row -- Badge is direct child of TooltipTrigger asChild (no span wrapper) */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge
              variant={SEVERITY_VARIANT[issue.severity] ?? 'secondary'}
              className={`text-xs ${issue.flag in SECURITY_EXPLAINERS ? 'cursor-pointer hover:underline' : ''}`}
              onClick={
                issue.flag in SECURITY_EXPLAINERS
                  ? (e: React.MouseEvent) => {
                      e.stopPropagation()
                      navigate({
                        to: '/dashboard/repos/$repoId/security/learn/$flag',
                        params: { repoId, flag: issue.flag },
                      })
                    }
                  : undefined
              }
            >
              <IconAlertTriangle />
              {likelihood} {flagLabel}
            </Badge>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant={PRIORITY_VARIANT[pLabel] ?? 'secondary'}
                  className="text-xs font-mono"
                >
                  {pLabel}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{PRIORITY_INFO[pLabel]}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant={SEVERITY_VARIANT[issue.severity] ?? 'secondary'}
                  className="text-xs"
                >
                  {sev.label}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{sev.tooltip}</TooltipContent>
            </Tooltip>
          </div>

          {/* Issue title */}
          {issue.title && (
            <p
              className={`text-sm font-medium ${isDismissed ? 'line-through' : ''}`}
            >
              {issue.title}
            </p>
          )}
          {issue.description && (
            <p className="text-sm text-muted-foreground">
              {issue.description}
            </p>
          )}

          {/* Detected in */}
          <div className="flex items-center gap-2 pt-0.5">
            <span className="text-xs text-muted-foreground">detected in</span>
            <FunctionRef
              functionName={fn.function_name}
              contentHash={fn.content_hash}
              repoId={repoId}
              minimal
            />
            <span className="text-xs text-muted-foreground">
              {fn.file_path}
            </span>
          </div>
        </div>

        {/* Actions -- stop propagation so clicks don't navigate */}
        <div
          className="shrink-0 flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          {fn.file_path && (
            <OpenInEditorButton
              repoId={repoId}
              filePath={fn.file_path}
              startLine={fn.start_line}
            />
          )}
          <IssueDismiss
            repoId={repoId}
            contentHash={fn.content_hash}
            issueIndex={issueIndex}
            flag={issue.flag}
            dismissed={dismissed}
          />
        </div>
      </div>
    </div>
    </TooltipProvider>
  )
}
