import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { IconBrandVscode, IconExternalLink, IconFunction } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { useBasePath } from '@/hooks/use-base-path'
import { cn } from '@/lib/utils'

export type FunctionRefProps = {
  /** Function name to display */
  functionName: string
  /** Content hash for linking to function detail page */
  contentHash: string
  /** Repo ID for route params and base path lookup */
  repoId: string
  /** File path relative to repo root -- enables "Open in editor" button */
  filePath?: string
  /** 1-indexed line where the function starts -- enables "open to line" in editor */
  startLine?: number
  /** Optional className for the outer wrapper */
  className?: string
  /** Render as plain text instead of a link -- use when inside a clickable card */
  disableLink?: boolean
  /** Render as a simple inline text link without icon -- use inside issue cards */
  minimal?: boolean
}

export function FunctionRef({
  functionName,
  contentHash,
  repoId,
  filePath,
  startLine,
  className,
  disableLink,
  minimal,
}: FunctionRefProps) {
  if (minimal) {
    return (
      <span className={cn('inline-flex items-center', className)}>
        <span className="font-mono text-sm font-medium text-primary">
          {functionName}()
        </span>
      </span>
    )
  }

  const nameContent = (
    <>
      <IconFunction className="size-5 shrink-0" />
      <span>{functionName}()</span>
    </>
  )

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      {disableLink ? (
        <span className="font-mono text-base font-medium text-foreground inline-flex items-center gap-1">
          {nameContent}
        </span>
      ) : (
        <Link
          to="/dashboard/repos/$repoId/fn/$contentHash"
          params={{ repoId, contentHash }}
          className="font-mono text-base font-medium text-foreground hover:underline inline-flex items-center gap-1"
        >
          {nameContent}
        </Link>
      )}
      {filePath && !disableLink && (
        <OpenInEditorButton repoId={repoId} filePath={filePath} startLine={startLine} />
      )}
    </span>
  )
}

/** Standalone "Open in VS Code" button for use on detail pages with more space */
export function OpenInEditorBlock({
  repoId,
  filePath,
  startLine,
}: {
  repoId: string
  filePath: string
  startLine?: number
}) {
  const [basePath, setBasePath] = useBasePath(repoId)
  const [showDialog, setShowDialog] = useState(false)
  const [pendingPath, setPendingPath] = useState('')

  function handleClick() {
    if (basePath) {
      openVSCodeUri(basePath, filePath, startLine)
    } else {
      setPendingPath('')
      setShowDialog(true)
    }
  }

  function handleSave() {
    if (pendingPath.trim()) {
      setBasePath(pendingPath.trim())
      setShowDialog(false)
      openVSCodeUri(pendingPath.trim(), filePath, startLine)
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={handleClick}>
        <IconBrandVscode className="size-3.5" />
        Open in VS Code
      </Button>
      <BasePathDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        pendingPath={pendingPath}
        onPendingPathChange={setPendingPath}
        onSave={handleSave}
      />
    </>
  )
}

export function OpenInEditorButton({
  repoId,
  filePath,
  startLine,
}: {
  repoId: string
  filePath: string
  startLine?: number
}) {
  const [basePath, setBasePath] = useBasePath(repoId)
  const [showDialog, setShowDialog] = useState(false)
  const [pendingPath, setPendingPath] = useState('')

  function handleEditorClick() {
    if (basePath) {
      openVSCodeUri(basePath, filePath, startLine)
    } else {
      setPendingPath('')
      setShowDialog(true)
    }
  }

  function handleSave() {
    if (pendingPath.trim()) {
      setBasePath(pendingPath.trim())
      setShowDialog(false)
      openVSCodeUri(pendingPath.trim(), filePath, startLine)
    }
  }

  return (
    <>
      {basePath ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              aria-label="Open in editor"
            >
              <IconExternalLink className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-auto">
            <DropdownMenuItem
              onClick={() => openVSCodeUri(basePath, filePath, startLine)}
            >
              <IconBrandVscode className="size-3.5" />
              Open in VS Code
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          aria-label="Open in editor"
          onClick={handleEditorClick}
        >
          <IconExternalLink className="size-3.5" />
        </Button>
      )}

      <BasePathDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        pendingPath={pendingPath}
        onPendingPathChange={setPendingPath}
        onSave={handleSave}
      />
    </>
  )
}

function BasePathDialog({
  open,
  onOpenChange,
  pendingPath,
  onPendingPathChange,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pendingPath: string
  onPendingPathChange: (path: string) => void
  onSave: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Set local project path</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                Ophan uses your local project path to construct VS Code URIs
                so you can jump directly from the web dashboard to your
                editor.
              </p>
              <p>
                For example, if your project is at{' '}
                <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">
                  /Users/you/projects/my-repo
                </code>{' '}
                and a function lives at{' '}
                <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">
                  src/auth.ts
                </code>
                , the URI becomes:
              </p>
              <pre className="font-mono text-xs bg-muted px-3 py-2 rounded overflow-x-auto">
                vscode://file/Users/you/projects/my-repo/src/auth.ts
              </pre>
              <p>
                To find your project path, run{' '}
                <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">
                  pwd
                </code>{' '}
                in your terminal from the repository root.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          placeholder="/Users/you/projects/my-repo"
          value={pendingPath}
          onChange={(e) => onPendingPathChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave()
          }}
          className="font-mono text-sm"
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onSave} disabled={!pendingPath.trim()}>
            Save
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Displays a file path with the user's base path prepended when available.
 * When no base path is set, shows a clickable placeholder to configure it.
 */
export function FilePathDisplay({
  repoId,
  filePath,
}: {
  repoId: string
  filePath: string
}) {
  const [basePath, setBasePath] = useBasePath(repoId)
  const [showDialog, setShowDialog] = useState(false)
  const [pendingPath, setPendingPath] = useState('')

  function handleSave() {
    if (pendingPath.trim()) {
      setBasePath(pendingPath.trim())
      setShowDialog(false)
    }
  }

  if (basePath) {
    const cleanBase = basePath.replace(/\/+$/, '')
    const cleanFile = filePath.replace(/^\/+/, '')
    return (
      <p className="text-muted-foreground text-sm font-mono">
        <span className="text-muted-foreground/50">{cleanBase}/</span>
        {cleanFile}
      </p>
    )
  }

  return (
    <>
      <p className="text-sm font-mono">
        <button
          onClick={() => {
            setPendingPath('')
            setShowDialog(true)
          }}
          className="text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
        >
          &lt;set path to repo&gt;
        </button>
        <span className="text-muted-foreground">/{filePath}</span>
      </p>
      <BasePathDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        pendingPath={pendingPath}
        onPendingPathChange={setPendingPath}
        onSave={handleSave}
      />
    </>
  )
}

export function openVSCodeUri(basePath: string, filePath: string, startLine?: number) {
  const cleanBase = basePath.replace(/\/+$/, '')
  const cleanFile = filePath.replace(/^\/+/, '')
  const lineSuffix = startLine && startLine > 0 ? `:${startLine}:1` : ''
  window.open(`vscode://file/${cleanBase}/${cleanFile}${lineSuffix}`, '_self')
}
