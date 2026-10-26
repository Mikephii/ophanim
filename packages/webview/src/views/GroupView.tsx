import { FC, useCallback } from "react";
import { MarkdownDoc } from "../components/MarkdownDoc";
import { useNavigationContext } from "../navigation";
import { useWebviewQuery } from "../use-webview-query";
import { CommunityCard } from "../components/dashboard/community-card";
import { Skeleton } from "../components/ui/skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";

type GroupDetailData = {
  summary: {
    community_id: string;
    title: string;
    documentation: string;
    meta: Record<string, unknown>;
  };
  communities: {
    community_id: string;
    title: string;
    documentation: string;
    meta: {
      complexity?: string;
      keyFunctions?: string[];
    };
  }[];
};

export const GroupView: FC = () => {
  const nav = useNavigationContext();
  const groupId = nav.current.params.groupId;

  const { data, isLoading, error, refetch } = useWebviewQuery<GroupDetailData>(
    "getGroupDetail",
    { groupId },
    { enabled: !!groupId },
  );

  const handleCommunityClick = useCallback(
    (communityId: string) => {
      nav.push({ view: "community-detail", params: { communityId } });
    },
    [nav],
  );

  if (isLoading && !data) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (error && !data) {
    return <ErrorState message={error} onRetry={refetch} />;
  }

  if (!data) {
    return <EmptyState title="Group not found" />;
  }

  return (
    <div className="p-4 space-y-5">
      {/* Group summary */}
      {data.summary.documentation && (
        <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] leading-relaxed">
          <MarkdownDoc>{data.summary.documentation}</MarkdownDoc>
        </div>
      )}

      {/* Child communities */}
      {data.communities.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Subsystems ({data.communities.length})
          </h3>
          <div className="space-y-1.5">
            {data.communities.map((comm) => (
              <CommunityCard
                key={comm.community_id}
                communityId={comm.community_id}
                title={comm.title}
                documentation={comm.documentation}
                meta={comm.meta}
                onNavigate={handleCommunityClick}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
