import { FC } from "react";
import { IconShieldCheck } from "@tabler/icons-react";
import { IssueCard } from "./issue-card";

type TopIssueItem = {
  content_hash: string;
  function_name: string;
  file_path: string;
  issue: {
    flag: string;
    title: string;
    description: string;
    severity: string;
    confidence?: string;
  };
};

interface Props {
  issues: TopIssueItem[];
  onNavigate: (contentHash: string, filePath: string) => void;
  onViewAll?: () => void;
}

export const TopIssues: FC<Props> = ({ issues, onNavigate, onViewAll }) => {
  if (issues.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
        <IconShieldCheck className="size-8 mb-2 text-green-500" />
        <p className="text-sm font-medium">No security issues found</p>
      </div>
    );
  }

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        Top Issues
      </h2>
      <div className="flex flex-col gap-2">
        {issues.map((item, i) => (
          <IssueCard
            key={`${item.content_hash}-${i}`}
            issue={item.issue}
            functionName={item.function_name}
            filePath={item.file_path}
            contentHash={item.content_hash}
            onNavigate={onNavigate}
          />
        ))}
      </div>
      {onViewAll && issues.length >= 8 && (
        <button
          onClick={onViewAll}
          className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors py-2"
        >
          View all issues &rarr;
        </button>
      )}
    </section>
  );
};
