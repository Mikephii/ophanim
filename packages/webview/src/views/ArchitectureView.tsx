import { FC, useCallback } from "react";
import { MarkdownDoc } from "../components/MarkdownDoc";
import { useNavigationContext } from "../navigation";
import { useWebviewQuery } from "../use-webview-query";
import { CommunityCard } from "../components/dashboard/community-card";
import { ConcernCard } from "../components/dashboard/concern-card";
import { Skeleton } from "../components/ui/skeleton";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { IconSitemap } from "@tabler/icons-react";

type CommunitySummary = {
  community_id: string;
  level: number;
  title: string;
  documentation: string;
  meta: {
    securityPosture?: string;
    dataClassification?: string[];
    boundaries?: string[];
    keyFunctions?: string[];
    complexity?: string;
  };
};

type CrossCuttingConcern = {
  community_id: string;
  title: string;
  concernType: string;
  tag: string;
  documentation: string;
  bridgeFunctions: unknown[];
  affectedCommunities: { communityId: string; communityTitle: string }[];
  severity: string;
};

type ArchitectureHierarchy = {
  l3: CommunitySummary | null;
  groups: {
    groupId: string;
    title: string;
    documentation: string;
    communities: CommunitySummary[];
  }[];
  ungrouped: CommunitySummary[];
  crossCutting: CrossCuttingConcern[];
};

export const ArchitectureView: FC = () => {
  const nav = useNavigationContext();

  const { data, isLoading, error, refetch } = useWebviewQuery<ArchitectureHierarchy>(
    "getArchitectureHierarchy",
  );

  const handleCommunityClick = useCallback(
    (communityId: string) => {
      nav.push({ view: "community-detail", params: { communityId } });
    },
    [nav],
  );

  const handleGroupClick = useCallback(
    (groupId: string) => {
      nav.push({ view: "group-detail", params: { groupId } });
    },
    [nav],
  );

  const handleConcernClick = useCallback(
    (concernId: string) => {
      nav.push({ view: "concern-detail", params: { concernId } });
    },
    [nav],
  );

  const handleConcernsIndex = useCallback(() => {
    nav.push({ view: "concerns-index", params: {} });
  }, [nav]);

  // Loading skeleton
  if (isLoading && !data) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  // Error state
  if (error && !data) {
    return <ErrorState message={error} onRetry={refetch} />;
  }

  // Empty state
  if (!data) {
    return (
      <EmptyState
        icon={<IconSitemap className="size-10" />}
        title="No architecture analysis found"
        description="Run ophan watch with architecture analysis enabled to generate documentation."
      />
    );
  }

  return (
    <div className="p-4 space-y-5">
      {/* L3 Architecture Overview */}
      {data.l3 && (
        <section>
          <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] leading-relaxed">
            <MarkdownDoc>{data.l3.documentation}</MarkdownDoc>
          </div>
        </section>
      )}

      {/* Groups (L2 with nested L1 communities) */}
      {data.groups.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Systems
          </h3>
          <div className="space-y-3">
            {data.groups.map((group) => (
              <div key={group.groupId}>
                <button
                  onClick={() => handleGroupClick(group.groupId)}
                  className="w-full text-left mb-1.5 hover:text-primary transition-colors"
                >
                  <h4 className="text-sm font-semibold">{group.title}</h4>
                  {group.documentation && (
                    <p className="text-xs text-muted-foreground line-clamp-1">
                      {group.documentation}
                    </p>
                  )}
                </button>
                <div className="space-y-1.5 pl-3 border-l-2 border-border">
                  {group.communities.map((comm) => (
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
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Ungrouped L1 communities */}
      {data.ungrouped.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            {data.groups.length > 0 ? "Other Subsystems" : "Subsystems"}
          </h3>
          <div className="space-y-1.5">
            {data.ungrouped.map((comm) => (
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

      {/* Cross-cutting Concerns */}
      {data.crossCutting.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Cross-Cutting Concerns
            </h3>
            {data.crossCutting.length > 3 && (
              <button
                onClick={handleConcernsIndex}
                className="text-[10px] text-primary hover:underline"
              >
                View all
              </button>
            )}
          </div>
          <div className="space-y-1.5">
            {data.crossCutting.map((concern) => (
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
        </section>
      )}
    </div>
  );
};
