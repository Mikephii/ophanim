import { FC, useCallback } from "react";
import { useWebviewQuery, useWebviewMutation } from "../use-webview-query";
import { Skeleton } from "../components/ui/skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import {
  IconActivity,
  IconPlayerPlay,
  IconTerminal,
  IconLoader2,
  IconCircleCheck,
  IconAlertTriangle,
  IconCircle,
  IconFile,
} from "@tabler/icons-react";

interface StatusSnapshot {
  mode: "vscode" | "browser";
  watchRunning: boolean;
  watchError: { type: string; message: string; severity: string } | null;
  analyzingFile: string | null;
  scanProgress: { current: number; total: number } | null;
  retryState: { attempt: number; maxAttempts: number } | null;
  staleFiles: string[];
  staleCount: number;
  recentErrorCount: number;
  activityLog: { timestamp: number; category: string; message: string }[];
}

function relativeTime(timestamp: number): string {
  const delta = Math.floor((Date.now() - timestamp) / 1000);
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

const CATEGORY_COLORS: Record<string, string> = {
  error: "text-red-500",
  analysis: "text-blue-400",
  scan: "text-green-400",
  sync: "text-purple-400",
  lifecycle: "text-muted-foreground",
};

function truncatePath(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  if (parts.length <= 3) return parts.join("/");
  return `.../${parts.slice(-3).join("/")}`;
}

export const StatusView: FC = () => {
  const { data: status, isLoading, error, refetch } = useWebviewQuery<StatusSnapshot>(
    "getStatus",
    undefined,
    { refetchOn: ["statusChanged"] },
  );

  const { mutate: analyzeNow } = useWebviewMutation("analyzeNow");
  const { mutate: openOutput } = useWebviewMutation("openOutput");
  const { mutate: openFile } = useWebviewMutation<{ filePath: string }>("openFile");

  const handleAnalyzeNow = useCallback(() => { analyzeNow(); }, [analyzeNow]);
  const handleOpenOutput = useCallback(() => { openOutput(); }, [openOutput]);
  const handleOpenFile = useCallback((filePath: string) => {
    openFile({ filePath });
  }, [openFile]);

  if (isLoading && !status) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (error && !status) {
    return <ErrorState message={error} onRetry={refetch} />;
  }

  if (!status) return null;

  // Browser mode placeholder
  if (status.mode === "browser") {
    return (
      <EmptyState
        icon={<IconActivity className="size-10" />}
        title="Status not available in browser mode"
        description="Open this project in VS Code to see live analysis status."
      />
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Watch Status */}
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2.5">
          {status.watchError ? (
            <IconAlertTriangle className="size-5 text-yellow-500 shrink-0" />
          ) : status.watchRunning ? (
            <IconCircleCheck className="size-5 text-green-500 shrink-0" />
          ) : (
            <IconCircle className="size-5 text-muted-foreground shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">
              {status.watchError
                ? "Stopped"
                : status.watchRunning
                  ? "Watch mode active"
                  : "Not running"}
            </p>
            {status.watchError && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {status.watchError.message}
              </p>
            )}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleAnalyzeNow}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <IconPlayerPlay className="size-3.5" />
            {status.watchError ? "Restart" : status.watchRunning ? "Re-analyze" : "Analyze Now"}
          </button>
          <button
            onClick={handleOpenOutput}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border hover:bg-muted transition-colors"
          >
            <IconTerminal className="size-3.5" />
            Output
          </button>
        </div>
      </div>

      {/* Analysis Progress (conditional) */}
      {(status.analyzingFile || status.scanProgress || status.retryState) && (
        <div className="rounded-lg border bg-card p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <IconLoader2 className="size-4 animate-spin text-blue-400 shrink-0" />
            <span className="font-medium">Analyzing</span>
          </div>
          {status.analyzingFile && (
            <p className="text-xs text-muted-foreground pl-6">
              {truncatePath(status.analyzingFile)}
            </p>
          )}
          {status.scanProgress && (
            <div className="pl-6 space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Scan progress</span>
                <span>{status.scanProgress.current} / {status.scanProgress.total}</span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all"
                  style={{
                    width: `${Math.round((status.scanProgress.current / status.scanProgress.total) * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}
          {status.retryState && (
            <p className="text-xs text-muted-foreground pl-6">
              Retry {status.retryState.attempt} / {status.retryState.maxAttempts}
            </p>
          )}
        </div>
      )}

      {/* Pending Files (conditional) */}
      {status.staleCount > 0 && (
        <div className="rounded-lg border bg-card p-4 space-y-2">
          <p className="text-sm font-medium">
            {status.staleCount} file{status.staleCount !== 1 ? "s" : ""} pending analysis
          </p>
          <div className="space-y-0.5 max-h-40 overflow-y-auto">
            {status.staleFiles.map((filePath) => (
              <button
                key={filePath}
                onClick={() => handleOpenFile(filePath)}
                className="flex items-center gap-2 w-full px-2 py-1 text-xs rounded hover:bg-muted transition-colors text-left"
              >
                <IconFile className="size-3.5 text-muted-foreground shrink-0" />
                <span className="truncate">{truncatePath(filePath)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Activity Log */}
      <div className="rounded-lg border bg-card p-4 space-y-2">
        <p className="text-sm font-medium">Recent Activity</p>
        {status.activityLog.length === 0 ? (
          <p className="text-xs text-muted-foreground">No recent activity.</p>
        ) : (
          <div className="space-y-0.5 max-h-64 overflow-y-auto">
            {[...status.activityLog].reverse().map((entry, i) => (
              <div
                key={`${entry.timestamp}-${i}`}
                className="flex items-start gap-2 px-2 py-1 text-xs"
              >
                <IconCircle
                  className={`size-2 mt-1 shrink-0 fill-current ${CATEGORY_COLORS[entry.category] ?? "text-muted-foreground"}`}
                />
                <span className="flex-1 min-w-0 break-words">{entry.message}</span>
                <span className="text-muted-foreground shrink-0 tabular-nums">
                  {relativeTime(entry.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
