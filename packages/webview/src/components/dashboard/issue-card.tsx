import { FC } from "react";
import { IconAlertTriangle, IconClock } from "@tabler/icons-react";
import { Badge } from "../ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import {
  SEVERITY_VARIANT,
  SEVERITY_BORDER,
  SEVERITY_INFO,
  PRIORITY_VARIANT,
  PRIORITY_INFO,
  CONFIDENCE_LABEL,
} from "../../utils/severity-tags";
import { priorityScore, priorityLabel } from "../../utils/security-utils";
import { flagLabel } from "../../utils/flag-labels";

interface IssueCardProps {
  issue: {
    flag: string;
    title: string;
    description: string;
    severity: string;
    confidence?: string;
  };
  functionName: string;
  filePath: string;
  contentHash: string;
  onNavigate: (contentHash: string, filePath: string) => void;
  potentiallyRemediated?: boolean;
}

export const IssueCard: FC<IssueCardProps> = ({
  issue,
  functionName,
  filePath,
  contentHash,
  onNavigate,
  potentiallyRemediated,
}) => {
  const score = priorityScore(issue.severity, issue.confidence ?? "medium");
  const pLabel = priorityLabel(score);
  const borderColor = potentiallyRemediated
    ? "border-l-muted-foreground/30"
    : SEVERITY_BORDER[issue.severity] ?? SEVERITY_BORDER.warning;
  const sev = SEVERITY_INFO[issue.severity] ?? SEVERITY_INFO.warning;
  const likelihood = CONFIDENCE_LABEL[issue.confidence ?? "medium"] ?? "likely";
  const label = flagLabel(issue.flag);

  // Truncate file path from the left
  const shortPath =
    filePath.length > 40 ? "..." + filePath.slice(-37) : filePath;

  return (
    <TooltipProvider>
      <button
        onClick={() => onNavigate(contentHash, filePath)}
        className={`w-full text-left border-l-4 ${borderColor} rounded-lg border bg-card p-3 transition-colors hover:bg-muted`}
      >
        <div className="space-y-1.5">
          {/* Badges row */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {potentiallyRemediated ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">
                    <IconClock className="size-3" />
                    Pending
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>Code was recently edited — re-analysis pending</TooltipContent>
              </Tooltip>
            ) : (
              <Badge
                variant={SEVERITY_VARIANT[issue.severity] ?? "secondary"}
                className="text-[10px]"
              >
                <IconAlertTriangle className="size-3" />
                {likelihood} {label}
              </Badge>
            )}
            {!potentiallyRemediated && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant={PRIORITY_VARIANT[pLabel] ?? "secondary"}
                      className="text-[10px] font-mono"
                    >
                      {pLabel}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{PRIORITY_INFO[pLabel]}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant={SEVERITY_VARIANT[issue.severity] ?? "secondary"}
                      className="text-[10px]"
                    >
                      {sev.label}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{sev.tooltip}</TooltipContent>
                </Tooltip>
              </>
            )}
          </div>

          {/* Title */}
          {issue.title && (
            <p className="text-sm font-medium">{issue.title}</p>
          )}

          {/* Description */}
          {issue.description && (
            <p className="text-xs text-muted-foreground line-clamp-2">
              {issue.description}
            </p>
          )}

          {/* Function + file */}
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="font-mono">{functionName}</span>
            <span>&middot;</span>
            <span className="truncate">{shortPath}</span>
          </div>
        </div>
      </button>
    </TooltipProvider>
  );
};
