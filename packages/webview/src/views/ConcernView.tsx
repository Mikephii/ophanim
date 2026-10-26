import { FC, useCallback } from "react";
import { MarkdownDoc } from "../components/MarkdownDoc";
import { useNavigationContext } from "../navigation";
import { useWebviewQuery } from "../use-webview-query";
import { Skeleton } from "../components/ui/skeleton";
import { Badge } from "../components/ui/badge";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { IconUsers } from "@tabler/icons-react";

type ConcernDetailData = {
  community_id: string;
  title: string;
  concernType: string;
  tag: string;
  documentation: string;
  severity: string;
  bridgeFunctions: {
    functionName: string;
    contentHash: string;
    communityId: string;
    centrality: number;
  }[];
  affectedCommunities: {
    communityId: string;
    communityTitle: string;
  }[];
  bridgeMembers: {
    content_hash: string;
    function_name: string;
    file_path: string;
    description: string;
  }[];
};

const SEVERITY_VARIANT: Record<string, "destructive" | "outline" | "secondary"> = {
  high: "destructive",
  medium: "outline",
  low: "secondary",
};

export const ConcernView: FC = () => {
  const nav = useNavigationContext();
  const concernId = nav.current.params.concernId;

  const { data, isLoading, error, refetch } = useWebviewQuery<ConcernDetailData>(
    "getConcernDetail",
    { concernId },
    { enabled: !!concernId },
  );

  const handleFunctionClick = useCallback(
    (contentHash: string, filePath: string) => {
      nav.push({ view: "function-detail", params: { contentHash, filePath } });
    },
    [nav],
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
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (error && !data) {
    return <ErrorState message={error} onRetry={refetch} />;
  }

  if (!data) {
    return <EmptyState title="Concern not found" />;
  }

  return (
    <div className="p-4 space-y-5">
      {/* Header badges */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant={SEVERITY_VARIANT[data.severity] ?? "secondary"}>
          {data.severity}
        </Badge>
        <Badge variant="outline">{data.concernType}</Badge>
      </div>

      {/* Documentation */}
      {data.documentation && (
        <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] leading-relaxed">
          <MarkdownDoc>{data.documentation}</MarkdownDoc>
        </div>
      )}

      {/* Bridge functions */}
      {data.bridgeMembers.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Bridge Functions ({data.bridgeMembers.length})
          </h3>
          <div className="space-y-1">
            {data.bridgeMembers.map((m) => (
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

      {/* Affected communities */}
      {data.affectedCommunities.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Affected Subsystems ({data.affectedCommunities.length})
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {data.affectedCommunities.map((ac) => (
              <button
                key={ac.communityId}
                onClick={() => handleCommunityClick(ac.communityId)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs border hover:bg-muted transition-colors"
              >
                <IconUsers className="size-3 text-muted-foreground" />
                {ac.communityTitle}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
