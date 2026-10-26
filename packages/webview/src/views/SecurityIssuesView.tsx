import { FC, useState, useCallback, useMemo } from "react";
import { useNavigationContext } from "../navigation";
import { useWebviewQuery, useWebviewMutation } from "../use-webview-query";
import { IssueCard } from "../components/dashboard/issue-card";
import { IssueDismiss } from "../components/dashboard/issue-dismiss";
import { Pagination } from "../components/ui/pagination";
import { Skeleton } from "../components/ui/skeleton";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Drawer } from "vaul";
import {
  IconFilter,
  IconShieldCheck,
  IconX,
  IconArrowBack,
} from "@tabler/icons-react";
import { SECURITY_FLAG_LABELS, flagLabel } from "../utils/flag-labels";

type SecurityIssueItem = {
  content_hash: string;
  function_name: string;
  file_path: string;
  language: string;
  entity_type: string;
  start_line: number;
  issue: {
    flag: string;
    title: string;
    description: string;
    severity: string;
    confidence?: string;
  };
  issueIndex: number;
  score: number;
  dismissed: boolean;
  adjustedLine?: number;
  potentiallyRemediated: boolean;
};

type SecurityIssuesResult = {
  items: SecurityIssueItem[];
  total: number;
  page: number;
};

const SEVERITY_OPTIONS = [
  { value: "", label: "All severities" },
  { value: "error", label: "Error" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
];

const PAGE_SIZE = 12;

export const SecurityIssuesView: FC = () => {
  const nav = useNavigationContext();

  // Read initial filter from route params
  const initialFlag = nav.current.params.flag ?? "";
  const initialSeverity = nav.current.params.severity ?? "";

  const [flag, setFlag] = useState(initialFlag);
  const [severity, setSeverity] = useState(initialSeverity);
  const [showDismissed, setShowDismissed] = useState(false);
  const [page, setPage] = useState(1);
  const [filterOpen, setFilterOpen] = useState(false);

  // Dismiss state
  const [dismissTarget, setDismissTarget] = useState<{
    contentHash: string;
    issueIndex: number;
    flag: string;
  } | null>(null);

  // Undismiss mutation
  const { mutate: undismiss } = useWebviewMutation("undismissIssue");

  // Build query params
  const queryParams = useMemo(
    () => ({
      ...(flag ? { flag } : {}),
      ...(severity ? { severity } : {}),
      showDismissed,
      page,
      pageSize: PAGE_SIZE,
    }),
    [flag, severity, showDismissed, page],
  );

  const { data, isLoading, refetch } = useWebviewQuery<SecurityIssuesResult>(
    "getSecurityIssues",
    queryParams,
  );

  const handleNavigateToFunction = useCallback(
    (contentHash: string, filePath: string) => {
      nav.push({ view: "function-detail", params: { contentHash, filePath } });
    },
    [nav],
  );

  const handleDismissed = useCallback(() => {
    setDismissTarget(null);
    refetch();
  }, [refetch]);

  const handleUndismiss = useCallback(
    async (contentHash: string, issueIndex: number) => {
      await undismiss({ contentHash, issueIndex });
      refetch();
    },
    [undismiss, refetch],
  );

  const handleClearFilters = useCallback(() => {
    setFlag("");
    setSeverity("");
    setShowDismissed(false);
    setPage(1);
  }, []);

  const hasFilters = flag || severity || showDismissed;
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Active filter chips
  const activeFilters: { key: string; label: string; onClear: () => void }[] = [];
  if (flag) {
    activeFilters.push({
      key: "flag",
      label: flagLabel(flag),
      onClear: () => { setFlag(""); setPage(1); },
    });
  }
  if (severity) {
    activeFilters.push({
      key: "severity",
      label: severity,
      onClear: () => { setSeverity(""); setPage(1); },
    });
  }
  if (showDismissed) {
    activeFilters.push({
      key: "dismissed",
      label: "showing dismissed",
      onClear: () => { setShowDismissed(false); setPage(1); },
    });
  }

  // Loading skeleton
  if (isLoading && !data) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header bar with count + filter, then pagination */}
      <div className="px-4 pt-3 pb-2 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">
              {total === 0
                ? "No issues"
                : `${total} issue${total !== 1 ? "s" : ""}`}
            </span>
            <Button
              variant="outline"
              size="xs"
              onClick={() => setFilterOpen(true)}
            >
              <IconFilter className="size-3.5" />
              Filter
            </Button>
            {hasFilters && (
              <Button variant="ghost" size="xs" onClick={handleClearFilters}>
                Clear
              </Button>
            )}
          </div>
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            disabled={isLoading}
          />
        </div>
      </div>

      {/* Active filter chips */}
      {activeFilters.length > 0 && (
        <div className="px-4 pb-2 flex flex-wrap gap-1.5">
          {activeFilters.map((f) => (
            <Badge
              key={f.key}
              variant="secondary"
              className="text-[10px] gap-1 pr-1"
            >
              {f.label}
              <button
                onClick={f.onClear}
                className="hover:text-foreground"
                aria-label={`Remove ${f.label} filter`}
              >
                <IconX className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* Issues list */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {items.length === 0 && !isLoading ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
            <IconShieldCheck className="size-8 mb-2 text-green-500" />
            <p className="text-sm font-medium">
              {hasFilters ? "No matching issues" : "No security issues found"}
            </p>
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={handleClearFilters}
              >
                <IconArrowBack className="size-3.5" />
                Clear filters
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div key={`${item.content_hash}-${item.issueIndex}`}>
                <IssueCard
                  issue={item.issue}
                  functionName={item.function_name}
                  filePath={item.file_path}
                  contentHash={item.content_hash}
                  onNavigate={handleNavigateToFunction}
                  potentiallyRemediated={item.potentiallyRemediated}
                />
                {/* Dismiss/restore action */}
                <div className="flex justify-end -mt-1 mb-1 pr-1">
                  {item.dismissed ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-[10px] text-muted-foreground"
                      onClick={() =>
                        handleUndismiss(item.content_hash, item.issueIndex)
                      }
                    >
                      Restore
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-[10px] text-muted-foreground"
                      onClick={() =>
                        setDismissTarget({
                          contentHash: item.content_hash,
                          issueIndex: item.issueIndex,
                          flag: item.issue.flag,
                        })
                      }
                    >
                      Dismiss
                    </Button>
                  )}
                </div>
              </div>
            ))}

            {/* Bottom pagination */}
            <Pagination
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
              disabled={isLoading}
            />
          </div>
        )}
      </div>

      {/* Filter bottom sheet */}
      <Drawer.Root open={filterOpen} onOpenChange={setFilterOpen}>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 bg-black/40 z-40" />
          <Drawer.Content
            className="fixed bottom-0 left-0 right-0 z-50 flex flex-col rounded-t-lg border-t"
            style={{
              backgroundColor: "var(--vscode-sideBar-background, var(--vscode-editor-background, hsl(var(--background))))",
              borderColor: "var(--vscode-panel-border, hsl(var(--border)))",
              color: "var(--vscode-editor-foreground, hsl(var(--foreground)))",
            }}
          >
            <div className="flex justify-center pt-3 pb-1">
              <div
                className="w-10 h-1 rounded-full"
                style={{
                  backgroundColor:
                    "var(--vscode-scrollbarSlider-background, hsl(var(--muted-foreground) / 0.3))",
                }}
              />
            </div>
            <Drawer.Title className="sr-only">Filter Issues</Drawer.Title>
            <Drawer.Description className="sr-only">
              Filter security issues by flag type and severity
            </Drawer.Description>

            <div className="px-4 pb-6 pt-2 space-y-4 max-h-[60vh] overflow-y-auto">
              <h3 className="text-sm font-semibold">Filter Issues</h3>

              {/* Flag filter */}
              <div>
                <label className="text-xs text-muted-foreground block mb-1.5">
                  Vulnerability type
                </label>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() => { setFlag(""); setPage(1); }}
                    className={`px-2.5 py-1.5 rounded-md text-xs transition-colors border ${
                      !flag
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-transparent hover:bg-muted text-muted-foreground"
                    }`}
                  >
                    All
                  </button>
                  {Object.entries(SECURITY_FLAG_LABELS).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => { setFlag(key); setPage(1); }}
                      className={`px-2.5 py-1.5 rounded-md text-xs transition-colors border ${
                        flag === key
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-transparent hover:bg-muted text-muted-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Severity filter */}
              <div>
                <label className="text-xs text-muted-foreground block mb-1.5">
                  Severity
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {SEVERITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => { setSeverity(opt.value); setPage(1); }}
                      className={`px-2.5 py-1.5 rounded-md text-xs transition-colors border ${
                        severity === opt.value
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-transparent hover:bg-muted text-muted-foreground"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Show dismissed toggle */}
              <div>
                <button
                  onClick={() => { setShowDismissed((v) => !v); setPage(1); }}
                  className={`flex items-center gap-2 px-2.5 py-2 rounded-md text-xs transition-colors border w-full ${
                    showDismissed
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-transparent hover:bg-muted text-muted-foreground"
                  }`}
                >
                  <span
                    className={`inline-block w-3.5 h-3.5 rounded border-2 ${
                      showDismissed
                        ? "bg-primary border-primary"
                        : "border-muted-foreground"
                    }`}
                  />
                  Show dismissed issues
                </button>
              </div>

              <Button
                variant="default"
                size="sm"
                className="w-full"
                onClick={() => setFilterOpen(false)}
              >
                Apply
              </Button>
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>

      {/* Dismiss bottom sheet */}
      {dismissTarget && (
        <IssueDismiss
          open={true}
          onOpenChange={(open) => {
            if (!open) setDismissTarget(null);
          }}
          contentHash={dismissTarget.contentHash}
          issueIndex={dismissTarget.issueIndex}
          flag={dismissTarget.flag}
          onDismissed={handleDismissed}
        />
      )}
    </div>
  );
};
