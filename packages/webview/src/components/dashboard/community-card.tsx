import { FC } from "react";
import { Badge } from "../ui/badge";

interface CommunityCardProps {
  communityId: string;
  title: string;
  documentation: string;
  meta?: {
    complexity?: string;
    keyFunctions?: string[];
  };
  onNavigate: (communityId: string) => void;
}

const COMPLEXITY_VARIANT: Record<string, "destructive" | "outline" | "secondary"> = {
  high: "destructive",
  medium: "outline",
  low: "secondary",
};

export const CommunityCard: FC<CommunityCardProps> = ({
  communityId,
  title,
  documentation,
  meta,
  onNavigate,
}) => {
  return (
    <button
      onClick={() => onNavigate(communityId)}
      className="w-full text-left rounded-lg border bg-card p-3 transition-colors hover:bg-muted"
    >
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium truncate flex-1">{title}</span>
          {meta?.complexity && (
            <Badge
              variant={COMPLEXITY_VARIANT[meta.complexity] ?? "secondary"}
              className="text-[10px] shrink-0"
            >
              {meta.complexity}
            </Badge>
          )}
        </div>
        {documentation && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {documentation}
          </p>
        )}
        {meta?.keyFunctions && meta.keyFunctions.length > 0 && (
          <p className="text-[11px] text-muted-foreground font-mono truncate">
            {meta.keyFunctions.slice(0, 3).join(", ")}
            {meta.keyFunctions.length > 3 && ` +${meta.keyFunctions.length - 3}`}
          </p>
        )}
      </div>
    </button>
  );
};
