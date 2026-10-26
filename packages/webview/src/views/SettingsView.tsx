import { FC } from "react";
import { useWebviewQuery } from "../use-webview-query";
import { Skeleton } from "../components/ui/skeleton";
import { Badge } from "../components/ui/badge";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { IconClipboardCheck } from "@tabler/icons-react";

type Practice = {
  practice_id: string;
  rule: string;
  severity: string;
};

const SEVERITY_VARIANT: Record<string, "destructive" | "outline" | "secondary"> = {
  error: "destructive",
  warning: "outline",
};

export const SettingsView: FC = () => {
  const { data, isLoading, error, refetch } = useWebviewQuery<Practice[]>("getPractices");

  if (isLoading && !data) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (error && !data) {
    return <ErrorState message={error} onRetry={refetch} />;
  }

  const practices = data ?? [];

  if (practices.length === 0) {
    return (
      <EmptyState
        icon={<IconClipboardCheck className="size-10" />}
        title="No practices configured"
        description="Add coding practices in the web dashboard to enforce team standards."
      />
    );
  }

  return (
    <div className="p-4 space-y-4">
      <p className="text-xs text-muted-foreground">
        {practices.length} practice{practices.length !== 1 ? "s" : ""} configured.
        Practices are managed in the web dashboard.
      </p>

      <div className="space-y-2">
        {practices.map((p) => (
          <div
            key={p.practice_id}
            className="rounded-lg border bg-card p-3 space-y-1.5"
          >
            <div className="flex items-center gap-2">
              <code className="text-[11px] text-muted-foreground font-mono">
                {p.practice_id}
              </code>
              <Badge
                variant={SEVERITY_VARIANT[p.severity] ?? "secondary"}
                className="text-[10px]"
              >
                {p.severity}
              </Badge>
            </div>
            <p className="text-sm">{p.rule}</p>
          </div>
        ))}
      </div>
    </div>
  );
};
