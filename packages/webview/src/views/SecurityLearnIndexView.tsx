import { FC, useCallback } from "react";
import { useNavigationContext } from "../navigation";
import { SECURITY_EXPLAINERS } from "../data/security-explainers";
import { SECURITY_TIER_LABELS, TIER_COLORS } from "../utils/flag-labels";
import { Badge } from "../components/ui/badge";

export const SecurityLearnIndexView: FC = () => {
  const nav = useNavigationContext();

  const handleFlagClick = useCallback(
    (flag: string) => {
      nav.push({ view: "security-learn", params: { flag } });
    },
    [nav],
  );

  const explainers = Object.values(SECURITY_EXPLAINERS).sort(
    (a, b) => a.tier - b.tier,
  );

  return (
    <div className="p-4 space-y-4">
      <p className="text-xs text-muted-foreground">
        Reference guide for vulnerability types detected by Ophan. Tap a
        vulnerability to learn about prevention.
      </p>

      <div className="space-y-1.5">
        {explainers.map((ex) => (
          <button
            key={ex.flag}
            onClick={() => handleFlagClick(ex.flag)}
            className="w-full text-left rounded-lg border bg-card p-3 transition-colors hover:bg-muted"
          >
            <div className="flex items-center gap-2">
              <span
                className={`inline-block w-2 h-2 rounded-full shrink-0 ${TIER_COLORS[ex.tier] ?? "bg-gray-400"}`}
              />
              <span className="text-sm font-medium flex-1">{ex.title}</span>
              <Badge variant="outline" className="text-[10px] shrink-0">
                {SECURITY_TIER_LABELS[ex.tier] ?? "Medium"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2 mt-1 pl-4">
              {ex.whatIsIt}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
};
