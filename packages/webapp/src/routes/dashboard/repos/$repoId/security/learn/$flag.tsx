import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { IconArrowLeft, IconExternalLink } from '@tabler/icons-react'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { SECURITY_EXPLAINERS } from '@/data/security-explainers'
import { SECURITY_TIER_LABELS } from '@ophan/core/schemas'
import { MarkdownRenderer } from '@/components/dashboard/markdown-renderer'
import { FunctionRef } from '@/components/dashboard/function-ref'
import { securityQueries } from '@/services/queries'

const TIER_DOT: Record<number, string> = {
  1: 'bg-red-500',
  2: 'bg-amber-500',
  3: 'bg-yellow-400',
  4: 'bg-gray-400',
}

export const Route = createFileRoute(
  '/dashboard/repos/$repoId/security/learn/$flag',
)({
  component: ExplainerDetailPage,
})

function ExplainerDetailPage() {
  const { repoId, flag } = Route.useParams()
  const explainer = SECURITY_EXPLAINERS[flag]

  const { data: issuesData } = useQuery(
    securityQueries.issues(repoId, { flag, pageSize: 5 }),
  )

  if (!explainer) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <Link
          to="/dashboard/repos/$repoId/security/learn"
          params={{ repoId }}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-4"
        >
          <IconArrowLeft className="size-3" />
          Back to reference
        </Link>
        <p className="text-muted-foreground">
          No explainer available for &ldquo;{flag}&rdquo;.
        </p>
      </div>
    )
  }

  const affectedFunctions = issuesData?.data ?? []

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Link
        to="/dashboard/repos/$repoId/security/learn"
        params={{ repoId }}
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-4"
      >
        <IconArrowLeft className="size-3" />
        Back to reference
      </Link>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <span
            className={`inline-block size-3 rounded-full ${TIER_DOT[explainer.tier] ?? TIER_DOT[3]}`}
          />
          <h1 className="text-2xl font-semibold">{explainer.title}</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline">
            {SECURITY_TIER_LABELS[explainer.tier] ?? 'Medium'} Risk
          </Badge>
          {explainer.cwe && (
            <Badge variant="secondary" className="font-mono">
              {explainer.cwe}
            </Badge>
          )}
          {explainer.owasp && (
            <Badge variant="secondary" className="font-mono">
              {explainer.owasp}
            </Badge>
          )}
        </div>
      </div>

      {/* What Is It? */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">What is it?</h2>
        <p className="text-muted-foreground">{explainer.whatIsIt}</p>
      </section>

      {/* How It Works */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">How it works</h2>
        <p className="text-muted-foreground">{explainer.howItWorks}</p>
      </section>

      {/* Vulnerable Code */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">Vulnerable code</h2>
        <MarkdownRenderer content={explainer.vulnerableCode} />
      </section>

      {/* Safe Code */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">Safe alternative</h2>
        <MarkdownRenderer content={explainer.safeCode} />
      </section>

      {/* Framework Notes */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">Framework considerations</h2>
        <p className="text-muted-foreground">{explainer.frameworkNotes}</p>
      </section>

      {/* In Your Codebase */}
      {affectedFunctions.length > 0 && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="text-base">In your codebase</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {affectedFunctions.map((fn) => (
                <div key={fn.content_hash} className="flex items-center gap-3">
                  <FunctionRef
                    functionName={fn.function_name}
                    contentHash={fn.content_hash}
                    repoId={repoId}
                    filePath={fn.file_path}
                    startLine={fn.start_line}
                  />
                  <span className="text-xs text-muted-foreground truncate">
                    {fn.file_path}
                  </span>
                </div>
              ))}
              {(issuesData?.total ?? 0) > 5 && (
                <Link
                  to="/dashboard/repos/$repoId/security/issues"
                  params={{ repoId }}
                  search={{ flag }}
                  className="text-sm text-primary hover:underline"
                >
                  View all {issuesData?.total} &rarr;
                </Link>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* References */}
      {explainer.references.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-3">References</h2>
          <ul className="space-y-1">
            {explainer.references.map((ref) => (
              <li key={ref.url}>
                <a
                  href={ref.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline inline-flex items-center gap-1"
                >
                  {ref.title}
                  <IconExternalLink className="size-3" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
