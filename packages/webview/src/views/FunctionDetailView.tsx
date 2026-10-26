import { FC, useEffect, useMemo } from "react";
import { useNavigationContext } from "../navigation";
import { useWebviewQuery } from "../use-webview-query";
import { FunctionDetail } from "../FunctionDetail";
import { Skeleton } from "../components/ui/skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { IconFunction, IconClock, IconLoader2 } from "@tabler/icons-react";
import { getVSCode } from "../useVSCode";
import { useFileAnalysisState } from "../use-file-analysis-state";
import type { FunctionData } from "../data";

/** Shape returned by getEnrichedFunction on extension host */
type EnrichedFunction = {
  file_path: string;
  function_name: string;
  content_hash: string;
  language: string;
  entity_type: string;
  start_line: number;
  analysis: {
    documentation: {
      description: string;
      params: { name: string; type: string; description: string }[];
      returns: { type: string; description: string };
    };
    security: {
      dataTags: string[];
      securityFlags: string[];
      issues: {
        flag: string;
        title: string;
        description: string;
        explanation: string;
        line: number;
        startText: string;
        endText: string;
        severity: string;
        confidence?: string;
      }[];
    };
    practices: {
      violations: {
        flag: string;
        title: string;
        description: string;
        explanation: string;
        line: number;
        startText: string;
        endText: string;
        severity: string;
      }[];
    };
  };
  /** Per-issue edit state (keyed "security:0", "practice:1", etc.) */
  editState?: Record<string, { adjustedLine: number; potentiallyRemediated: boolean }>;
};

/** Convert EnrichedFunction from extension host to FunctionData for FunctionDetail */
function toFunctionData(ef: EnrichedFunction): FunctionData {
  return {
    name: ef.function_name,
    filePath: ef.file_path,
    startLine: ef.start_line,
    endLine: 0,
    contentHash: ef.content_hash,
    description: ef.analysis.documentation.description,
    params: ef.analysis.documentation.params,
    returns: ef.analysis.documentation.returns,
    dataTags: ef.analysis.security.dataTags,
    securityFlags: ef.analysis.security.securityFlags,
    issues: ef.analysis.security.issues.map((i, idx) => {
      const state = ef.editState?.[`security:${idx}`];
      return {
        ...i,
        severity: i.severity as "error" | "warning" | "info",
        adjustedLine: state?.adjustedLine,
        potentiallyRemediated: state?.potentiallyRemediated ?? false,
      };
    }),
    practiceViolations: ef.analysis.practices.violations.map((v, idx) => {
      const state = ef.editState?.[`practice:${idx}`];
      return {
        ...v,
        severity: v.severity as "error" | "warning" | "info",
        adjustedLine: state?.adjustedLine,
        potentiallyRemediated: state?.potentiallyRemediated ?? false,
      };
    }),
    language: ef.language,
    entityType: ef.entity_type,
  };
}

interface Props {
  /** Pre-loaded function data from legacy CodeLens flow */
  legacyData?: FunctionData | null;
}

export const FunctionDetailView: FC<Props> = ({ legacyData }) => {
  const nav = useNavigationContext();
  const contentHash = nav.current.params.contentHash;
  const functionName = nav.current.params.name;
  const filePath = nav.current.params.filePath;
  const analysisState = useFileAnalysisState(filePath);

  // Only use legacy data if it matches the current nav target
  const matchingLegacy =
    legacyData?.contentHash === contentHash ? legacyData : null;

  const { data, isLoading, error, refetch } = useWebviewQuery<EnrichedFunction>(
    "getEnrichedFunction",
    { contentHash },
    { enabled: !!contentHash },
  );

  // Fallback: resolve new hash when old hash is orphaned after re-analysis
  const shouldResolve = !isLoading && !data && !error && !!functionName && !!filePath;
  const { data: resolved } = useWebviewQuery<{ contentHash: string }>(
    "resolveCurrentHash",
    { functionName, filePath },
    { enabled: shouldResolve },
  );

  // Auto-navigate to new hash (nav.replace prevents infinite loop:
  // new contentHash → primary query succeeds → shouldResolve = false)
  useEffect(() => {
    if (resolved?.contentHash && resolved.contentHash !== contentHash) {
      nav.replace({
        view: "function-detail",
        params: { contentHash: resolved.contentHash, name: functionName, filePath },
      });
    }
  }, [resolved, contentHash, functionName, filePath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Prefer query data (includes edit state) over legacy; legacy is instant fallback
  const functionData = useMemo(() => {
    if (data) return toFunctionData(data);
    if (matchingLegacy) return matchingLegacy;
    return null;
  }, [matchingLegacy, data]);

  const handleGoToDefinition = (
    filePath: string,
    line: number,
    functionName?: string,
  ) => {
    const vscode = getVSCode();
    vscode?.postMessage({
      type: "goToDefinition",
      filePath,
      line,
      functionName: functionName || "",
    });
  };

  if (isLoading && !functionData) {
    return (
      <div className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-5 w-16" />
        </div>
        <Skeleton className="h-px w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (error && !functionData) {
    return <ErrorState message={error} onRetry={refetch} />;
  }

  if (!functionData) {
    return (
      <EmptyState
        icon={<IconFunction className="size-10" />}
        title="Function not found"
        description="This function may have been removed or its hash changed."
      />
    );
  }

  return (
    <div className="p-4">
      {analysisState === "stale" && (
        <div
          className="flex items-center gap-2 px-3 py-2 mb-4 rounded-md text-xs"
          style={{
            backgroundColor: "var(--vscode-editorWarning-background, hsl(var(--muted)))",
            color: "var(--vscode-editorWarning-foreground, hsl(var(--muted-foreground)))",
          }}
        >
          <IconClock className="size-3.5 shrink-0" />
          <span>Edited — pending re-analysis</span>
        </div>
      )}
      {analysisState === "analyzing" && (
        <div
          className="flex items-center gap-2 px-3 py-2 mb-4 rounded-md text-xs"
          style={{
            backgroundColor: "var(--vscode-editorInfo-background, hsl(var(--muted)))",
            color: "var(--vscode-editorInfo-foreground, hsl(var(--muted-foreground)))",
          }}
        >
          <IconLoader2 className="size-3.5 shrink-0 animate-spin" />
          <span>Re-analyzing...</span>
        </div>
      )}
      <FunctionDetail fn={functionData} onGoToDefinition={handleGoToDefinition} />
    </div>
  );
};
