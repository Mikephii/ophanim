import { FC } from "react";
import { Badge } from "../ui/badge";
import { IconAlertTriangle } from "@tabler/icons-react";

interface FunctionCardProps {
  functionName: string;
  filePath: string;
  contentHash: string;
  language: string;
  description: string;
  issueCount: number;
  onNavigate: (contentHash: string, filePath: string) => void;
}

/** Language abbreviation for badge display */
const LANG_SHORT: Record<string, string> = {
  typescript: "TS",
  javascript: "JS",
  python: "PY",
  go: "Go",
  rust: "RS",
  java: "Java",
  ruby: "RB",
  php: "PHP",
  swift: "Swift",
  kotlin: "KT",
  csharp: "C#",
  c: "C",
  cpp: "C++",
};

function langShort(language: string): string {
  return LANG_SHORT[language] ?? language.slice(0, 3).toUpperCase();
}

/** Truncate file path from the left */
function truncatePath(path: string, max = 45): string {
  return path.length > max ? "..." + path.slice(-(max - 3)) : path;
}

export const FunctionCard: FC<FunctionCardProps> = ({
  functionName,
  filePath,
  contentHash,
  language,
  description,
  issueCount,
  onNavigate,
}) => {
  return (
    <button
      onClick={() => onNavigate(contentHash, filePath)}
      className="w-full text-left rounded-lg border bg-card p-3 transition-colors hover:bg-muted"
    >
      <div className="space-y-1">
        {/* Function name + badges */}
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-sm font-medium truncate flex-1">
            {functionName}
          </span>
          <Badge variant="outline" className="text-[10px] shrink-0">
            {langShort(language)}
          </Badge>
          {issueCount > 0 && (
            <Badge variant="destructive" className="text-[10px] shrink-0 gap-0.5">
              <IconAlertTriangle className="size-3" />
              {issueCount}
            </Badge>
          )}
        </div>

        {/* File path */}
        <p className="text-[11px] text-muted-foreground truncate">
          {truncatePath(filePath)}
        </p>

        {/* Description */}
        {description && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {description}
          </p>
        )}
      </div>
    </button>
  );
};
