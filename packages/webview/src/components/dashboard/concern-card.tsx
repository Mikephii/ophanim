import { FC } from "react";
import { Badge } from "../ui/badge";
import { IconShieldExclamation, IconArrowsTransferDown } from "@tabler/icons-react";

interface ConcernCardProps {
  concernId: string;
  title: string;
  concernType: string;
  severity: string;
  affectedCount: number;
  bridgeCount: number;
  onNavigate: (concernId: string) => void;
}

const TYPE_ICON: Record<string, FC<{ className?: string }>> = {
  security: IconShieldExclamation,
  data_flow: IconArrowsTransferDown,
};

const SEVERITY_VARIANT: Record<string, "destructive" | "outline" | "secondary"> = {
  high: "destructive",
  medium: "outline",
  low: "secondary",
};

export const ConcernCard: FC<ConcernCardProps> = ({
  concernId,
  title,
  concernType,
  severity,
  affectedCount,
  bridgeCount,
  onNavigate,
}) => {
  const TypeIcon = TYPE_ICON[concernType] ?? IconShieldExclamation;

  return (
    <button
      onClick={() => onNavigate(concernId)}
      className="w-full text-left rounded-lg border bg-card p-3 transition-colors hover:bg-muted"
    >
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <TypeIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium truncate flex-1">{title}</span>
          <Badge
            variant={SEVERITY_VARIANT[severity] ?? "secondary"}
            className="text-[10px] shrink-0"
          >
            {severity}
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>{affectedCount} subsystem{affectedCount !== 1 ? "s" : ""}</span>
          <span>{bridgeCount} bridge fn{bridgeCount !== 1 ? "s" : ""}</span>
        </div>
      </div>
    </button>
  );
};
