import { Badge } from '@/components/ui/badge'

interface SummaryMeta {
  securityPosture: string
  dataClassification: string[]
  boundaries: string[]
  keyFunctions: string[]
  complexity: 'low' | 'medium' | 'high'
}

const COMPLEXITY_VARIANT: Record<string, 'default' | 'secondary' | 'destructive'> = {
  low: 'secondary',
  medium: 'default',
  high: 'destructive',
}

export function MetaBadges({ meta }: { meta: SummaryMeta }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      <Badge variant={COMPLEXITY_VARIANT[meta.complexity] ?? 'default'} className="text-xs">
        {meta.complexity}
      </Badge>
      {meta.dataClassification.map((tag) => (
        <Badge key={tag} variant="outline" className="text-xs">
          {tag}
        </Badge>
      ))}
      {meta.boundaries.map((b) => (
        <Badge key={b} variant="secondary" className="text-xs">
          {b}
        </Badge>
      ))}
    </div>
  )
}
