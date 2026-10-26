import { FC, useCallback } from "react";
import { useWebviewQuery } from "../use-webview-query";
import { useNavigationContext } from "../navigation";
import { SecurityHero } from "../components/dashboard/security-hero";
import { SecurityCategories } from "../components/dashboard/security-categories";
import { TopIssues } from "../components/dashboard/top-issues";
import { Skeleton } from "../components/ui/skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { IconShield } from "@tabler/icons-react";

export const HomeView: FC = () => {
  const nav = useNavigationContext();

  const { data: stats, isLoading: statsLoading, error: statsError, refetch: refetchStats } = useWebviewQuery<{
    posture: "critical" | "warning" | "clean";
    criticalCount: number;
    errorCount: number;
    warningCount: number;
    totalFunctions: number;
    flagBreakdown: Record<
      string,
      { count: number; errorCount: number; warningCount: number; infoCount: number }
    >;
  }>("getSecurityDashboardStats");

  const { data: topIssues, isLoading: issuesLoading, error: issuesError } = useWebviewQuery<
    {
      content_hash: string;
      function_name: string;
      file_path: string;
      issue: {
        flag: string;
        title: string;
        description: string;
        severity: string;
        confidence?: string;
      };
    }[]
  >("getTopIssues");

  const handleNavigateToFunction = useCallback(
    (contentHash: string, filePath: string) => {
      nav.push({ view: "function-detail", params: { contentHash, filePath } });
    },
    [nav],
  );

  const handleFlagClick = useCallback(
    (flag: string) => {
      nav.push({ view: "security-issues", params: { flag } });
    },
    [nav],
  );

  const handleViewAllIssues = useCallback(() => {
    nav.push({ view: "security-issues", params: {} });
  }, [nav]);

  const isLoading = statsLoading || issuesLoading;
  const error = statsError || issuesError;

  // Error state
  if (error && !stats && !topIssues) {
    return <ErrorState message={error} onRetry={refetchStats} />;
  }

  // Loading skeleton
  if (isLoading && !stats && !topIssues) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-6 w-48" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  // Empty state -- no data at all
  if (stats && stats.totalFunctions === 0) {
    return (
      <EmptyState
        icon={<IconShield className="size-10" />}
        title="No security analysis found"
        description="Run ophan watch to analyze your codebase."
      />
    );
  }

  return (
    <div className="p-4 space-y-5">
      {stats && <SecurityHero stats={stats} />}

      <TopIssues
        issues={topIssues ?? []}
        onNavigate={handleNavigateToFunction}
        onViewAll={handleViewAllIssues}
      />

      {stats && Object.keys(stats.flagBreakdown).length > 0 && (
        <SecurityCategories
          breakdown={stats.flagBreakdown}
          onFlagClick={handleFlagClick}
        />
      )}
    </div>
  );
};
