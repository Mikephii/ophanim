import { FC } from "react";
import { flagLabel, flagTier, TIER_COLORS } from "../../utils/flag-labels";

type FlagBreakdownEntry = {
  count: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
};

interface Props {
  breakdown: Record<string, FlagBreakdownEntry>;
  onFlagClick: (flag: string) => void;
}

export const SecurityCategories: FC<Props> = ({ breakdown, onFlagClick }) => {
  const entries = Object.entries(breakdown)
    .filter(([, e]) => e.count > 0)
    .sort((a, b) => {
      const tierA = flagTier(a[0]);
      const tierB = flagTier(b[0]);
      if (tierA !== tierB) return tierA - tierB;
      return b[1].count - a[1].count;
    });

  if (entries.length === 0) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        By Category
      </h2>
      <div className="flex flex-col gap-1">
        {entries.map(([flag, entry]) => {
          const tier = flagTier(flag);
          return (
            <button
              key={flag}
              onClick={() => onFlagClick(flag)}
              className="flex items-center gap-2.5 px-2.5 py-2 rounded-md text-sm transition-colors hover:bg-muted w-full text-left"
            >
              <span
                className={`inline-block size-2.5 rounded-full shrink-0 ${TIER_COLORS[tier]}`}
              />
              <span className="flex-1 truncate">{flagLabel(flag)}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {entry.count}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
};
