import { FC, useCallback } from "react";
import { useNavigationContext } from "../navigation";
import { useWebviewQuery } from "../use-webview-query";
import { ConcernCard } from "../components/dashboard/concern-card";
import { Skeleton } from "../components/ui/skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { IconArrowsTransferDown } from "@tabler/icons-react";

type CrossCuttingConcern = {
  community_id: string;
  title: string;
  concernType: string;
  severity: string;
  bridgeFunctions: unknown[];
  affectedCommunities: { communityId: string; communityTitle: string }[];
};

export const ConcernsIndexView: FC = () => {
  const nav = useNavigationContext();

  const { data, isLoading, error, refetch } = useWebviewQuery<CrossCuttingConcern[]>(
    "getConcernsIndex",
  );

  const handleConcernClick = useCallback(
    (concernId: string) => {
      nav.push({ view: "concern-detail", params: { concernId } });
    },
    [nav],
  );

  if (isLoading && !data) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (error && !data) {
    return <ErrorState message={error} onRetry={refetch} />;
  }

  const concerns = data ?? [];

  if (concerns.length === 0) {
    return (
      <EmptyState
        icon={<IconArrowsTransferDown className="size-10" />}
        title="No cross-cutting concerns detected"
        description="Cross-cutting concerns are patterns that span multiple subsystems, like shared data flows or security boundaries."
      />
    );
  }

  return (
    <div className="p-4 space-y-4">
      <p className="text-xs text-muted-foreground">
        Cross-cutting concerns are patterns that span multiple subsystems —
        shared data flows, security boundaries, or infrastructure dependencies.
      </p>

      <div className="space-y-1.5">
        {concerns.map((concern) => (
          <ConcernCard
            key={concern.community_id}
            concernId={concern.community_id}
            title={concern.title}
            concernType={concern.concernType}
            severity={concern.severity}
            affectedCount={concern.affectedCommunities.length}
            bridgeCount={concern.bridgeFunctions.length}
            onNavigate={handleConcernClick}
          />
        ))}
      </div>
    </div>
  );
};
