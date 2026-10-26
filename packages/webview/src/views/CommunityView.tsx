import { FC, useCallback } from "react";
import { MarkdownDoc } from "../components/MarkdownDoc";
import { useNavigationContext } from "../navigation";
import { useWebviewQuery } from "../use-webview-query";
import { ConcernCard } from "../components/dashboard/concern-card";
import { Skeleton } from "../components/ui/skeleton";
import { Badge } from "../components/ui/badge";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { IconUsers } from "@tabler/icons-react";

type CommunityDetailData = {
  summary: {
    community_id: string;
    title: string;
    documentation: string;
    meta: {
      complexity?: string;
      keyFunctions?: string[];
      securityPosture?: string;
    };
  };
  members: {
    content_hash: string;
    function_name: string;
    file_path: string;
    description: string;
  }[];
  relatedCommunities: {
    communityId: string;
    title: string;
    weight: number;
    edgeCount: number;
  }[];
  relatedConcerns: {
    community_id: string;
    title: string;
    concernType: string;
    severity: string;
    bridgeFunctions: unknown[];
    affectedCommunities: { communityId: string; communityTitle: string }[];
  }[];
};

export const CommunityView: FC = () => {
  const nav = useNavigationContext();
  const communityId = nav.current.params.communityId;

  const { data, isLoading, error, refetch } = useWebviewQuery<CommunityDetailData>(
    "getCommunityDetail",
    { communityId },
    { enabled: !!communityId },
  );

  const handleFunctionClick = useCallback(
    (contentHash: string, filePath: string) => {
      nav.push({ view: "function-detail", params: { contentHash, filePath } });
    },
    [nav],
  );

  const handleCommunityClick = useCallback(
    (id: string) => {
      nav.push({ view: "community-detail", params: { communityId: id } });
    },
    [nav],
  );

  const handleConcernClick = useCallback(
    (concernId: string) => {
      nav.push({ view: "concern-detail", params: { concernId } });
    },
    [nav],
  );

  if (isLoading && !data) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (error && !data) {
    return <ErrorState message={error} onRetry={refetch} />;
  }

  if (!data) {
    return <EmptyState title="Community not found" />;
  }

  const { summary, members, relatedCommunities, relatedConcerns } = data;

  return (
    <div className="p-4 space-y-5">
      {/* Summary markdown */}
      {summary.documentation && (
        <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] leading-relaxed">
          <MarkdownDoc>{summary.documentation}</MarkdownDoc>
        </div>
      )}

      {/* Member functions */}
      {members.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Member Functions ({members.length})
          </h3>
          <div className="space-y-1">
            {members.map((m) => (
              <button
                key={m.content_hash}
                onClick={() => handleFunctionClick(m.content_hash, m.file_path)}
                className="w-full text-left rounded-md px-3 py-2 transition-colors hover:bg-muted"
              >
                <span className="font-mono text-sm">{m.function_name}</span>
                <span className="text-[11px] text-muted-foreground ml-2 truncate">
                  {m.file_path}
                </span>
                {m.description && (
                  <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                    {m.description}
                  </p>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Related communities */}
      {relatedCommunities.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Related Subsystems
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {relatedCommunities.map((rc) => (
              <button
                key={rc.communityId}
                onClick={() => handleCommunityClick(rc.communityId)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs border hover:bg-muted transition-colors"
              >
                <IconUsers className="size-3 text-muted-foreground" />
                {rc.title}
                <Badge variant="secondary" className="text-[10px] ml-0.5">
                  {rc.edgeCount}
                </Badge>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Related concerns */}
      {relatedConcerns.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Related Concerns
          </h3>
          <div className="space-y-1.5">
            {relatedConcerns.map((concern) => (
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
