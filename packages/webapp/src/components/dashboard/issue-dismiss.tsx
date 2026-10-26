import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { IconAlertHexagonOff, IconDots, IconArrowBackUp } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { dismissIssue, undismissIssue } from '@/services/api/security'
import { queryKeys } from '@/services/queries/keys'
import type { DismissedIssue, DismissReason } from '@/services/api/types'
import { DISMISS_REASON_LABELS } from '@/services/api/types'

interface IssueDismissProps {
  repoId: string
  contentHash: string
  issueIndex: number
  flag: string
  dismissed?: DismissedIssue
}

const REASON_OPTIONS: { reason: DismissReason; label: string; description: string }[] = [
  {
    reason: 'false_positive',
    label: 'False Positive',
    description: 'Not actually a vulnerability',
  },
  {
    reason: 'accepted_risk',
    label: 'Accepted Risk',
    description: 'Known risk, accepted by the team',
  },
  {
    reason: 'wont_fix',
    label: "Won't Fix",
    description: 'Not worth fixing right now',
  },
]

export function IssueDismiss({
  repoId,
  contentHash,
  issueIndex,
  flag,
  dismissed,
}: IssueDismissProps) {
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [selectedReason, setSelectedReason] = useState<DismissReason>('false_positive')
  const [note, setNote] = useState('')

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.security.dismissed(repoId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.security.dashboard(repoId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.security.issues(repoId) })
  }

  const dismissMutation = useMutation({
    mutationFn: (data: { reason: DismissReason; note?: string }) =>
      dismissIssue({
        data: {
          repoId,
          contentHash,
          issueIndex,
          flag,
          reason: data.reason,
          note: data.note,
        },
      }),
    onSuccess: () => {
      setDialogOpen(false)
      setNote('')
      invalidate()
    },
  })

  const undismissMutation = useMutation({
    mutationFn: () =>
      undismissIssue({ data: { repoId, contentHash, issueIndex } }),
    onSuccess: invalidate,
  })

  // Already dismissed -- show reason badge + menu with restore
  if (dismissed) {
    return (
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className="text-xs text-muted-foreground">
          {DISMISS_REASON_LABELS[dismissed.reason]}
        </Badge>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
              <IconDots className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem
              onClick={() => undismissMutation.mutate()}
              disabled={undismissMutation.isPending}
            >
              <IconArrowBackUp className="size-3.5 mr-2" />
              Restore
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  // Not dismissed -- show dismiss button + menu
  return (
    <>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-muted-foreground hover:text-foreground"
          onClick={() => setDialogOpen(true)}
        >
          <IconAlertHexagonOff className="size-3.5" />
          <span className="text-xs">Dismiss</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
            >
              <IconDots className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={() => setDialogOpen(true)}>
              <IconAlertHexagonOff className="size-3.5 mr-2" />
              Dismiss
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Dismiss dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dismiss Issue</DialogTitle>
            <DialogDescription>
              Why are you dismissing this issue? This helps your team track risk decisions.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Reason selection */}
            <div className="space-y-2">
              {REASON_OPTIONS.map((opt) => (
                <label
                  key={opt.reason}
                  className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                    selectedReason === opt.reason
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-muted-foreground/30'
                  }`}
                >
                  <input
                    type="radio"
                    name="dismiss-reason"
                    value={opt.reason}
                    checked={selectedReason === opt.reason}
                    onChange={() => setSelectedReason(opt.reason)}
                    className="mt-0.5"
                  />
                  <div>
                    <p className="text-sm font-medium">{opt.label}</p>
                    <p className="text-xs text-muted-foreground">{opt.description}</p>
                  </div>
                </label>
              ))}
            </div>

            {/* Optional note */}
            <div>
              <Textarea
                placeholder="Optional note..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="text-sm resize-none"
                rows={2}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                dismissMutation.mutate({
                  reason: selectedReason,
                  note: note || undefined,
                })
              }
              disabled={dismissMutation.isPending}
            >
              {dismissMutation.isPending ? 'Dismissing...' : 'Dismiss'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
