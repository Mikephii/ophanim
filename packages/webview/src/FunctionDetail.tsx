import { FC } from "react";
import { FunctionData, DetailedIssue } from "./data";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent } from "./components/ui/card";
import { Separator } from "./components/ui/separator";
import { IconExternalLink, IconAlertTriangle, IconClipboardCheck, IconArrowRight, IconClock } from "@tabler/icons-react";
import { toFileLine } from "./utils/line-utils";
import { SEVERITY_VARIANT } from "./utils/severity-tags";

interface Props {
  fn: FunctionData;
  onGoToDefinition: (filePath: string, line: number, functionName?: string) => void;
}

const tagVariantMap: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; label?: string }> = {
  user_input: { variant: "default", label: "user input" },
  pii: { variant: "destructive", label: "PII" },
  credentials: { variant: "destructive" },
  database: { variant: "secondary" },
  external_api: { variant: "outline", label: "external API" },
  file_system: { variant: "secondary", label: "file system" },
  config: { variant: "outline" },
  internal: { variant: "outline" },
};

export const FunctionDetail: FC<Props> = ({ fn, onGoToDefinition }) => {
  const {
    name,
    description,
    params,
    returns,
    dataTags,
    securityFlags,
    filePath,
    startLine,
    language,
    entityType,
  } = fn;

  // Split issues into active vs pending re-analysis
  const activeIssues = fn.issues.filter(i => !i.potentiallyRemediated);
  const pendingIssues = fn.issues.filter(i => i.potentiallyRemediated);
  const activePractices = (fn.practiceViolations ?? []).filter(v => !v.potentiallyRemediated);
  const pendingPractices = (fn.practiceViolations ?? []).filter(v => v.potentiallyRemediated);
  const hasPending = pendingIssues.length > 0 || pendingPractices.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <header className="flex items-center gap-2 flex-wrap">
        <h1 className="text-lg font-semibold text-foreground">{name}</h1>
        <Badge variant="secondary" className="text-[10px]">
          {language}
        </Badge>
        {entityType !== "function" && (
          <Badge variant="outline" className="text-[10px]">
            {entityType}
          </Badge>
        )}
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto text-muted-foreground"
          onClick={() => onGoToDefinition(filePath, startLine, name)}
          title="Go to definition"
        >
          {filePath.split("/").pop()}{startLine > 0 ? `:${startLine}` : ""}
          <IconExternalLink data-icon="inline-end" className="size-3" />
        </Button>
      </header>

      <Separator />

      {/* Description */}
      <p className="text-sm leading-relaxed text-foreground">{description}</p>

      {/* Parameters */}
      {params.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
            Parameters
          </h3>
          <div className="flex flex-col gap-1.5">
            {params.map((p) => (
              <div
                key={p.name}
                className="flex items-baseline gap-2 py-1.5 px-2.5 bg-muted/30 rounded-md text-sm"
              >
                <code className="text-primary font-mono text-xs">{p.name}</code>
                <span className="text-muted-foreground text-xs">{p.type}</span>
                <span className="text-foreground/80 text-xs flex-1">{p.description}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Returns */}
      {returns.type && returns.type !== "void" && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
            Returns
          </h3>
          <div className="flex gap-2 items-baseline text-sm">
            <span className="text-muted-foreground text-xs">{returns.type}</span>
            <span className="text-foreground/80 text-xs">{returns.description}</span>
          </div>
        </section>
      )}

      {/* Data Flow Tags */}
      {dataTags.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
            Data Flow
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {dataTags.map((tag) => {
              const config = tagVariantMap[tag] || { variant: "outline" as const };
              return (
                <Badge key={tag} variant={config.variant}>
                  {config.label || tag.replace(/_/g, " ")}
                </Badge>
              );
            })}
          </div>
        </section>
      )}

      {/* Security Concerns -- active issues only */}
      {securityFlags.length > 0 && activeIssues.length > 0 && (
        <Card size="sm" className="border-destructive/30 bg-destructive/5 ring-destructive/20 py-3 gap-2">
          <CardContent className="px-3">
            <h3 className="text-xs font-semibold text-destructive mb-2 uppercase tracking-wide flex items-center gap-1.5">
              <IconAlertTriangle className="size-3.5" />
              Security Concerns
            </h3>
            <div className="flex flex-col gap-3">
              {activeIssues.map((issue, i) => {
                const fileLine = issue.adjustedLine != null
                  ? issue.adjustedLine + 1
                  : toFileLine(startLine, issue.line);
                return (
                  <div key={i} className="border-l-2 pl-2.5 border-destructive/30">
                    <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                      <Badge
                        variant={SEVERITY_VARIANT[issue.severity] ?? "outline"}
                        className="text-[10px] px-1.5 py-0"
                      >
                        {issue.severity}
                      </Badge>
                      <span className="text-xs font-medium text-destructive">
                        {issue.title || issue.flag.replace(/_/g, " ")}
                      </span>
                      {fileLine > 0 && (
                        <Button
                          variant="ghost"
                          size="xs"
                          className="h-5 px-1 text-[10px] text-muted-foreground ml-auto"
                          onClick={() => onGoToDefinition(filePath, fileLine)}
                          title={`Go to line ${fileLine}`}
                        >
                          L{fileLine}
                          <IconArrowRight className="size-2.5" />
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-foreground/80">{issue.description}</p>
                    {issue.explanation && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">{issue.explanation}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Practice Violations -- active only */}
      {activePractices.length > 0 && (
        <Card size="sm" className="border-amber-500/30 bg-amber-500/5 ring-amber-500/20 py-3 gap-2">
          <CardContent className="px-3">
            <h3 className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-2 uppercase tracking-wide flex items-center gap-1.5">
              <IconClipboardCheck className="size-3.5" />
              Practice Violations
            </h3>
            <div className="flex flex-col gap-3">
              {activePractices.map((v, i) => {
                const fileLine = v.adjustedLine != null
                  ? v.adjustedLine + 1
                  : toFileLine(startLine, v.line);
                return (
                  <div key={i} className="border-l-2 pl-2.5 border-amber-500/30">
                    <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                      <Badge
                        variant={v.severity === "error" ? "destructive" : "warning"}
                        className="text-[10px] px-1.5 py-0"
                      >
                        {v.severity}
                      </Badge>
                      <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                        {v.title || v.flag.replace(/_/g, " ")}
                      </span>
                      {fileLine > 0 && (
                        <Button
                          variant="ghost"
                          size="xs"
                          className="h-5 px-1 text-[10px] text-muted-foreground ml-auto"
                          onClick={() => onGoToDefinition(filePath, fileLine)}
                          title={`Go to line ${fileLine}`}
                        >
                          L{fileLine}
                          <IconArrowRight className="size-2.5" />
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-foreground/80">{v.description}</p>
                    {v.explanation && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">{v.explanation}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pending Re-analysis -- remediated issues from both security and practices */}
      {hasPending && (
        <Card size="sm" className="border-border bg-muted/30 py-3 gap-2">
          <CardContent className="px-3">
            <h3 className="text-xs font-semibold text-muted-foreground mb-1 uppercase tracking-wide flex items-center gap-1.5">
              <IconClock className="size-3.5" />
              Pending Re-analysis
            </h3>
            <p className="text-[11px] text-muted-foreground mb-3">
              These issues were recently edited and can no longer be found. They may be remediated.
            </p>
            <div className="flex flex-col gap-3">
              {pendingIssues.map((issue, i) => (
                <PendingIssueRow key={`sec-${i}`} issue={issue} />
              ))}
              {pendingPractices.map((v, i) => (
                <PendingIssueRow key={`prac-${i}`} issue={v} kind="practice" />
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

const PendingIssueRow: FC<{ issue: DetailedIssue; kind?: "security" | "practice" }> = ({ issue, kind = "security" }) => (
  <div className="border-l-2 border-border pl-2.5">
    <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
        {issue.severity}
      </Badge>
      {kind === "practice" && (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
          practice
        </Badge>
      )}
      <span className="text-xs font-medium text-muted-foreground">
        {issue.title || issue.flag.replace(/_/g, " ")}
      </span>
    </div>
    <p className="text-xs text-muted-foreground">{issue.description}</p>
    {issue.explanation && (
      <p className="text-[11px] text-muted-foreground/70 mt-0.5">{issue.explanation}</p>
    )}
  </div>
);
