import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { IconGitCommit, IconGitBranch, IconHistory, IconTrash, IconPlus, IconClipboardCheck } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { repoQueries, architectureQueries, practicesQueries } from '@/services/queries'
import {
  wipeArchitectureData,
  wipeFunctionAnalysis,
  updateDocsBranch,
} from '@/services/api/architecture'
import {
  createPractice,
  updatePractice,
  deletePractice,
} from '@/services/api/practices'
import { useBasePath } from '@/hooks/use-base-path'
import { MAX_PRACTICES, MAX_RULE_LENGTH } from '@ophan/core/schemas'

export const Route = createFileRoute('/dashboard/repos/$repoId/settings')({
  component: RepoSettingsPage,
})

function ConfirmWipeDialog({
  title,
  description,
  onConfirm,
  trigger,
}: {
  title: string
  description: string
  onConfirm: () => Promise<unknown>
  trigger: React.ReactNode
}) {
  const [confirmText, setConfirmText] = useState('')
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: onConfirm,
    onSuccess: () => {
      queryClient.invalidateQueries()
      setOpen(false)
      setConfirmText('')
    },
  })

  return (
    <AlertDialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) {
          setConfirmText('')
          mutation.reset()
        }
      }}
    >
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Type <span className="font-mono font-semibold text-foreground">DELETE</span> to confirm:
          </p>
          <Input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="Type DELETE"
            autoComplete="off"
          />
          {mutation.error && (
            <p className="text-sm text-destructive">
              Something went wrong. Please try again.
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={confirmText !== 'DELETE' || mutation.isPending}
            onClick={(e) => {
              e.preventDefault()
              mutation.mutate()
            }}
          >
            {mutation.isPending ? 'Deleting...' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function BasePathSetting({ repoId }: { repoId: string }) {
  const [basePath, setBasePath] = useBasePath(repoId)
  const [draft, setDraft] = useState(basePath ?? '')

  function handleSave() {
    const trimmed = draft.trim()
    if (trimmed) {
      setBasePath(trimmed)
    }
  }

  function handleClear() {
    setDraft('')
    localStorage.removeItem(`ophan:basePath:${repoId}`)
    // Force re-render by setting state
    setBasePath('')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Local project path</CardTitle>
        <CardDescription>
          The absolute path to this repository on your machine. Used to
          construct{' '}
          <code className="font-mono text-xs">vscode://file/...</code> URIs
          so you can open files directly in your editor from the web
          dashboard. Run{' '}
          <code className="font-mono text-xs">pwd</code> in your terminal
          from the repo root to find this.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <Input
            placeholder="/Users/you/projects/my-repo"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
            }}
            className="font-mono text-sm flex-1"
          />
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!draft.trim() || draft.trim() === basePath}
          >
            Save
          </Button>
          {basePath && (
            <Button variant="ghost" size="sm" onClick={handleClear}>
              Clear
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function DocsBranchSetting({ repoId, currentBranch }: { repoId: string; currentBranch: string }) {
  const [draft, setDraft] = useState(currentBranch)
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: () => updateDocsBranch({ data: { repoId, docsBranch: draft.trim() } }),
    onSuccess: () => {
      queryClient.invalidateQueries()
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Documentation branch</CardTitle>
        <CardDescription>
          Architecture docs (community summaries, subsystem documentation) are
          only synced to the cloud when the CLI runs on this branch. Other
          branches can generate docs locally but won't overwrite the cloud
          version. For non-git projects this setting is ignored.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <Input
            placeholder="main"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim() && draft.trim() !== currentBranch) {
                mutation.mutate()
              }
            }}
            className="font-mono text-sm flex-1 max-w-xs"
          />
          <Button
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={!draft.trim() || draft.trim() === currentBranch || mutation.isPending}
          >
            {mutation.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
        {mutation.error && (
          <p className="text-sm text-destructive mt-2">
            Failed to update. Please try again.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function relativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffMins = Math.floor(diffMs / 60_000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 30) return `${diffDays}d ago`
  const diffMonths = Math.floor(diffDays / 30)
  return `${diffMonths}mo ago`
}

function DocsSyncHistory({
  repoId,
  lastCommit,
  lastBranch,
  lastSyncedAt,
}: {
  repoId: string
  lastCommit: string | null
  lastBranch: string
  lastSyncedAt: string | null
}) {
  const [open, setOpen] = useState(false)
  const { data: history, isLoading } = useQuery({
    ...architectureQueries.syncHistory(repoId),
    enabled: open,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Docs sync history</CardTitle>
        <CardDescription>
          Each time architecture docs are synced to the cloud, the git commit is
          recorded. Use this to track which version of your code the current docs
          were generated from.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {lastCommit ? (
          <div className="space-y-3">
            <div className="flex items-center gap-4 rounded-md border px-4 py-3">
              <div className="flex items-center gap-2 min-w-0">
                <IconGitCommit className="size-4 shrink-0 text-muted-foreground" />
                <code className="font-mono text-sm">{lastCommit.slice(0, 7)}</code>
              </div>
              <div className="flex items-center gap-2 min-w-0">
                <IconGitBranch className="size-4 shrink-0 text-muted-foreground" />
                <code className="font-mono text-sm">{lastBranch}</code>
              </div>
              {lastSyncedAt && (
                <span className="text-sm text-muted-foreground ml-auto shrink-0">
                  {relativeTime(lastSyncedAt)}
                </span>
              )}
            </div>
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm">
                  <IconHistory className="size-4 mr-1.5" />
                  View full history
                </Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Docs Sync History</SheetTitle>
                  <SheetDescription>
                    Recent architecture documentation syncs for this repository.
                  </SheetDescription>
                </SheetHeader>
                <div className="px-4 pb-4 overflow-y-auto flex-1">
                  {isLoading && (
                    <p className="text-sm text-muted-foreground">Loading...</p>
                  )}
                  {history && history.length === 0 && (
                    <p className="text-sm text-muted-foreground">No sync history yet.</p>
                  )}
                  {history && history.length > 0 && (
                    <div className="space-y-1">
                      {history.map((entry, i) => (
                        <div
                          key={entry.id}
                          className="flex items-center gap-4 rounded-md px-3 py-2 text-sm hover:bg-muted/50"
                        >
                          <code className="font-mono text-xs shrink-0">
                            {entry.commit_hash.slice(0, 7)}
                          </code>
                          <div className="flex items-center gap-1.5 text-muted-foreground min-w-0">
                            <IconGitBranch className="size-3 shrink-0" />
                            <span className="truncate">{entry.branch}</span>
                          </div>
                          <span className="text-xs text-muted-foreground ml-auto shrink-0">
                            {relativeTime(entry.synced_at)}
                          </span>
                          {i === 0 && (
                            <span className="text-[10px] font-medium uppercase tracking-wider text-primary bg-primary/10 px-1.5 py-0.5 rounded shrink-0">
                              Latest
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </SheetContent>
            </Sheet>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No architecture docs have been synced yet. Run{' '}
            <code className="text-xs">ophan graph --summarize</code> then{' '}
            <code className="text-xs">ophan sync</code> to generate and sync
            architecture docs.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

const SEVERITY_OPTIONS = ['error', 'warning', 'info'] as const

function PracticesSection({ repoId }: { repoId: string }) {
  const queryClient = useQueryClient()
  const { data: practices, isLoading } = useQuery(practicesQueries.list(repoId))

  const [newId, setNewId] = useState('')
  const [newRule, setNewRule] = useState('')
  const [newSeverity, setNewSeverity] = useState<'error' | 'warning' | 'info'>('warning')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editRule, setEditRule] = useState('')
  const [editSeverity, setEditSeverity] = useState<'error' | 'warning' | 'info'>('warning')

  const createMutation = useMutation({
    mutationFn: () =>
      createPractice({
        data: { repoId, practiceId: newId.trim(), rule: newRule.trim(), severity: newSeverity },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repos', repoId, 'practices'] })
      setNewId('')
      setNewRule('')
      setNewSeverity('warning')
    },
  })

  const updateMutation = useMutation({
    mutationFn: (vars: { id: string; rule: string; severity: 'error' | 'warning' | 'info' }) =>
      updatePractice({ data: { repoId, id: vars.id, rule: vars.rule, severity: vars.severity } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repos', repoId, 'practices'] })
      setEditingId(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deletePractice({ data: { repoId, id } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['repos', repoId, 'practices'] })
    },
  })

  const atLimit = (practices?.length ?? 0) >= MAX_PRACTICES
  const canCreate = newId.trim() && newRule.trim() && !atLimit && !createMutation.isPending

  function startEdit(p: { id: string; rule: string; severity: 'error' | 'warning' | 'info' }) {
    setEditingId(p.id)
    setEditRule(p.rule)
    setEditSeverity(p.severity)
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <IconClipboardCheck className="size-5 text-muted-foreground" />
          <CardTitle className="text-base">Coding Practices</CardTitle>
        </div>
        <CardDescription>
          Define team coding practices that Ophan checks during analysis.
          Violations appear as diagnostics in VS Code and on the web dashboard.
          Run <code className="text-xs">ophan sync</code> after changes to
          update local analysis.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading...</p>
        )}

        {/* Existing practices */}
        {practices && practices.length > 0 && (
          <div className="space-y-2">
            {practices.map((p) => (
              <div
                key={p.id}
                className="flex items-start gap-2 rounded-md border px-3 py-2"
              >
                {editingId === p.id ? (
                  <div className="flex-1 space-y-2">
                    <Input
                      value={editRule}
                      onChange={(e) => setEditRule(e.target.value)}
                      placeholder="Rule description"
                      className="text-sm"
                      maxLength={MAX_RULE_LENGTH}
                    />
                    <div className="flex items-center gap-2">
                      <Select
                        value={editSeverity}
                        onValueChange={(v) => setEditSeverity(v as any)}
                      >
                        <SelectTrigger className="w-28 h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SEVERITY_OPTIONS.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8"
                        onClick={() =>
                          updateMutation.mutate({
                            id: p.id,
                            rule: editRule.trim(),
                            severity: editSeverity,
                          })
                        }
                        disabled={
                          !editRule.trim() || updateMutation.isPending
                        }
                      >
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <code className="text-xs font-mono text-muted-foreground">
                          {p.practice_id}
                        </code>
                        <span
                          className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded ${
                            p.severity === 'error'
                              ? 'text-destructive bg-destructive/10'
                              : p.severity === 'warning'
                                ? 'text-amber-600 bg-amber-500/10'
                                : 'text-blue-600 bg-blue-500/10'
                          }`}
                        >
                          {p.severity}
                        </span>
                      </div>
                      <p
                        className="text-sm mt-0.5 cursor-pointer hover:text-foreground text-muted-foreground"
                        onClick={() => startEdit({ id: p.id, rule: p.rule, severity: p.severity })}
                        title="Click to edit"
                      >
                        {p.rule}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => deleteMutation.mutate(p.id)}
                      disabled={deleteMutation.isPending}
                    >
                      <IconTrash className="size-3.5" />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {practices && practices.length === 0 && !isLoading && (
          <p className="text-sm text-muted-foreground">
            No practices defined yet. Add your first practice below.
          </p>
        )}

        {/* Add new practice */}
        <div className="rounded-md border border-dashed p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Input
              placeholder="practice-id"
              value={newId}
              onChange={(e) => setNewId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              className="font-mono text-sm max-w-[180px]"
            />
            <Select
              value={newSeverity}
              onValueChange={(v) => setNewSeverity(v as any)}
            >
              <SelectTrigger className="w-28 h-9 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEVERITY_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Rule description (e.g. Always use parameterized queries for SQL)"
              value={newRule}
              onChange={(e) => setNewRule(e.target.value)}
              className="text-sm flex-1"
              maxLength={MAX_RULE_LENGTH}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canCreate) createMutation.mutate()
              }}
            />
            <Button
              size="sm"
              onClick={() => createMutation.mutate()}
              disabled={!canCreate}
            >
              <IconPlus className="size-4 mr-1" />
              Add
            </Button>
          </div>
          {createMutation.error && (
            <p className="text-sm text-destructive">
              {(createMutation.error as Error).message}
            </p>
          )}
          {atLimit && (
            <p className="text-xs text-muted-foreground">
              Maximum {MAX_PRACTICES} practices reached.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function RepoSettingsPage() {
  const { repoId } = Route.useParams()
  const { data: repo } = useQuery(repoQueries.detail(repoId))

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Settings</h1>
        {repo?.name && (
          <p className="text-muted-foreground text-sm mt-0.5">{repo.name}</p>
        )}
      </div>

      {/* Local Settings */}
      <div className="space-y-4 mb-8">
        <div>
          <h2 className="text-lg font-medium">Local Settings</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            These settings are personal to you and stored in your browser.
            They are not shared with your team.
          </p>
        </div>
        <BasePathSetting repoId={repoId} />
      </div>

      {/* Repository Settings */}
      <div className="space-y-4 mb-8">
        <div>
          <h2 className="text-lg font-medium">Repository Settings</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            These settings apply to this repository for all team members.
          </p>
        </div>
        <PracticesSection repoId={repoId} />
        <DocsBranchSetting
          repoId={repoId}
          currentBranch={repo?.docs_branch ?? 'main'}
        />
        <DocsSyncHistory
          repoId={repoId}
          lastCommit={repo?.last_docs_sync_commit ?? null}
          lastBranch={repo?.docs_branch ?? 'main'}
          lastSyncedAt={repo?.last_docs_sync_at ?? null}
        />
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-medium text-destructive">Danger Zone</h2>
        <div className="space-y-4 rounded-lg border border-destructive/30 p-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Clear Architecture Data
              </CardTitle>
              <CardDescription>
                Delete all community detection results, summaries, and
                cross-cutting concern documentation for this repository. You can
                regenerate this data by running{' '}
                <code className="text-xs">ophan graph --summarize</code> and
                syncing again.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ConfirmWipeDialog
                title="Clear Architecture Data"
                description="This will permanently delete all community summaries, community membership data, and community edge data for this repository. This action cannot be undone."
                onConfirm={() =>
                  wipeArchitectureData({ data: { repoId } })
                }
                trigger={
                  <Button variant="destructive" size="sm">
                    Clear Architecture Data
                  </Button>
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Clear Function Analysis
              </CardTitle>
              <CardDescription>
                Delete all function analysis results and file location mappings
                for this repository. You can regenerate this data by running{' '}
                <code className="text-xs">ophan analyze</code> and syncing
                again.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ConfirmWipeDialog
                title="Clear Function Analysis"
                description="This will permanently delete all function analysis entries and file location mappings for this repository. This action cannot be undone."
                onConfirm={() =>
                  wipeFunctionAnalysis({ data: { repoId } })
                }
                trigger={
                  <Button variant="destructive" size="sm">
                    Clear Function Analysis
                  </Button>
                }
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
