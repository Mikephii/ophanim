import { FC } from "react";
import {
  IconShieldCheck,
  IconAlertTriangle,
  IconFlame,
  IconCode,
} from "@tabler/icons-react";
import { Card, CardContent, CardDescription, CardHeader } from "../ui/card";
import {
  flagLabel,
  flagTier,
  TIER_COLORS,
} from "../../utils/flag-labels";

type FlagBreakdownEntry = {
  count: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
};

type SecurityDashboardStats = {
  posture: "critical" | "warning" | "clean";
  criticalCount: number;
  errorCount: number;
  warningCount: number;
  totalFunctions: number;
  flagBreakdown: Record<string, FlagBreakdownEntry>;
};

const PostureBadge: FC<{ posture: SecurityDashboardStats["posture"] }> = ({
  posture,
}) => {
  if (posture === "critical") {
    return (
      <div className="flex items-center gap-2 text-destructive">
        <IconFlame className="size-5" />
        <span className="text-base font-semibold">Critical Issues Found</span>
      </div>
    );
  }
  if (posture === "warning") {
    return (
      <div className="flex items-center gap-2 text-amber-500">
        <IconAlertTriangle className="size-5" />
        <span className="text-base font-semibold">Needs Attention</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
      <IconShieldCheck className="size-5" />
      <span className="text-base font-semibold">No Issues Found</span>
    </div>
  );
};

const DistributionBar: FC<{
  breakdown: Record<string, FlagBreakdownEntry>;
}> = ({ breakdown }) => {
  const entries = Object.entries(breakdown).sort((a, b) => {
    const tierA = flagTier(a[0]);
    const tierB = flagTier(b[0]);
    if (tierA !== tierB) return tierA - tierB;
    return b[1].count - a[1].count;
  });

  const total = entries.reduce((sum, [, e]) => sum + e.count, 0);
  if (total === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground font-medium">
        Issue Distribution
      </p>
      <div className="flex h-2.5 rounded-full overflow-hidden gap-0.5">
        {entries.map(([flag, entry]) => {
          const tier = flagTier(flag);
          const pct = (entry.count / total) * 100;
          return (
            <div
              key={flag}
              className={`${TIER_COLORS[tier]} transition-opacity`}
              style={{ flexGrow: pct }}
              title={`${flagLabel(flag)}: ${entry.count} issues`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {entries.map(([flag, entry]) => {
          const tier = flagTier(flag);
          return (
            <div
              key={flag}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <span
                className={`inline-block size-2 rounded-full ${TIER_COLORS[tier]}`}
              />
              <span>{flagLabel(flag)}</span>
              <span className="font-medium text-foreground">{entry.count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const SecurityHero: FC<{ stats: SecurityDashboardStats }> = ({
  stats,
}) => {
  return (
    <div className="space-y-4">
      <PostureBadge posture={stats.posture} />

      <div className="grid gap-3 grid-cols-2">
        <Card size="sm">
          <CardHeader className="pb-1">
            <CardDescription className="flex items-center gap-1 text-[11px]">
              <IconFlame className="size-3" />
              Critical
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-bold text-destructive">
              {stats.criticalCount}
            </p>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="pb-1">
            <CardDescription className="flex items-center gap-1 text-[11px]">
              <IconAlertTriangle className="size-3" />
              Errors
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-bold text-orange-500">
              {stats.errorCount}
            </p>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="pb-1">
            <CardDescription className="flex items-center gap-1 text-[11px]">
              <IconAlertTriangle className="size-3" />
              Warnings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-bold text-amber-500">
              {stats.warningCount}
            </p>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader className="pb-1">
            <CardDescription className="flex items-center gap-1 text-[11px]">
              <IconCode className="size-3" />
              Functions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-bold">{stats.totalFunctions}</p>
          </CardContent>
        </Card>
      </div>

      <DistributionBar breakdown={stats.flagBreakdown} />
    </div>
  );
};
