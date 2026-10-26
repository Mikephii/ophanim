import { FC } from "react";
import { MarkdownDoc } from "../components/MarkdownDoc";
import { useNavigationContext } from "../navigation";
import { SECURITY_EXPLAINERS } from "../data/security-explainers";
import { SECURITY_TIER_LABELS, TIER_COLORS } from "../utils/flag-labels";
import { Badge } from "../components/ui/badge";
import { IconExternalLink } from "@tabler/icons-react";

export const SecurityLearnView: FC = () => {
  const nav = useNavigationContext();
  const flag = nav.current.params.flag;

  const explainer = flag ? SECURITY_EXPLAINERS[flag] : undefined;

  if (!explainer) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center text-muted-foreground">
        <p className="text-sm font-medium">Vulnerability type not found</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-5 overflow-y-auto">
      {/* Header badges */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`inline-block w-2.5 h-2.5 rounded-full ${TIER_COLORS[explainer.tier] ?? "bg-gray-400"}`}
        />
        <Badge variant="outline" className="text-[10px]">
          {SECURITY_TIER_LABELS[explainer.tier] ?? "Medium"} Risk
        </Badge>
        {explainer.cwe && (
          <Badge variant="secondary" className="text-[10px]">
            {explainer.cwe}
          </Badge>
        )}
        {explainer.owasp && (
          <Badge variant="secondary" className="text-[10px]">
            {explainer.owasp}
          </Badge>
        )}
      </div>

      {/* What is it? */}
      <section>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
          What is it?
        </h3>
        <p className="text-sm leading-relaxed">{explainer.whatIsIt}</p>
      </section>

      {/* How it works */}
      <section>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
          How it works
        </h3>
        <p className="text-sm leading-relaxed">{explainer.howItWorks}</p>
      </section>

      {/* Vulnerable code */}
      <section>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
          Vulnerable Code
        </h3>
        <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] [&_pre]:!bg-muted [&_pre]:!p-3 [&_pre]:!rounded-md [&_pre]:!text-xs [&_pre]:!overflow-x-auto">
          <MarkdownDoc>{explainer.vulnerableCode}</MarkdownDoc>
        </div>
      </section>

      {/* Safe code */}
      <section>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
          Safe Code
        </h3>
        <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] [&_pre]:!bg-muted [&_pre]:!p-3 [&_pre]:!rounded-md [&_pre]:!text-xs [&_pre]:!overflow-x-auto">
          <MarkdownDoc>{explainer.safeCode}</MarkdownDoc>
        </div>
      </section>

      {/* Framework notes */}
      {explainer.frameworkNotes && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
            Framework Notes
          </h3>
          <p className="text-sm leading-relaxed">{explainer.frameworkNotes}</p>
        </section>
      )}

      {/* References */}
      {explainer.references.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
            References
          </h3>
          <div className="space-y-1">
            {explainer.references.map((ref) => (
              <a
                key={ref.url}
                href={ref.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-primary hover:underline"
              >
                <IconExternalLink className="size-3 shrink-0" />
                {ref.title}
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
