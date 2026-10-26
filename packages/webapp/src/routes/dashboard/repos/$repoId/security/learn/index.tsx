import { createFileRoute, Link } from '@tanstack/react-router'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { SECURITY_EXPLAINERS } from '@/data/security-explainers'
import {
  SECURITY_TIER_LABELS,
} from '@ophan/core/schemas'

const TIER_DOT: Record<number, string> = {
  1: 'bg-red-500',
  2: 'bg-amber-500',
  3: 'bg-yellow-400',
  4: 'bg-gray-400',
}

export const Route = createFileRoute(
  '/dashboard/repos/$repoId/security/learn/',
)({
  component: LearnIndexPage,
})

function LearnIndexPage() {
  const { repoId } = Route.useParams()

  const explainers = Object.values(SECURITY_EXPLAINERS).sort(
    (a, b) => a.tier - b.tier || a.title.localeCompare(b.title),
  )

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Security Reference</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Learn about common vulnerability types and how to fix them.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {explainers.map((exp) => (
          <Link
            key={exp.flag}
            to="/dashboard/repos/$repoId/security/learn/$flag"
            params={{ repoId, flag: exp.flag }}
            className="block"
          >
            <Card className="hover:border-primary/50 transition-colors h-full">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block size-2.5 rounded-full ${TIER_DOT[exp.tier] ?? TIER_DOT[3]}`}
                  />
                  <CardTitle className="text-base">{exp.title}</CardTitle>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="outline" className="text-xs">
                    {SECURITY_TIER_LABELS[exp.tier] ?? 'Medium'}
                  </Badge>
                  {exp.cwe && (
                    <Badge variant="secondary" className="text-xs font-mono">
                      {exp.cwe}
                    </Badge>
                  )}
                  {exp.owasp && (
                    <Badge variant="secondary" className="text-xs font-mono">
                      {exp.owasp}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {exp.whatIsIt}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
