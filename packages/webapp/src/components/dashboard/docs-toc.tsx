import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

interface TocEntry {
  id: string
  text: string
  level: number
}

function extractHeadings(markdown: string): TocEntry[] {
  const entries: TocEntry[] = []
  const lines = markdown.split('\n')
  for (const line of lines) {
    const match = line.match(/^(#{2,3})\s+(.+)$/)
    if (match) {
      const level = match[1].length
      const text = match[2].trim()
      const id = text
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
      entries.push({ id, text, level })
    }
  }
  return entries
}

export function DocsToc({ content }: { content: string }) {
  const headings = extractHeadings(content)
  const [activeId, setActiveId] = useState<string>('')

  useEffect(() => {
    if (headings.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id)
          }
        }
      },
      { rootMargin: '-80px 0px -80% 0px' },
    )

    for (const heading of headings) {
      const el = document.getElementById(heading.id)
      if (el) observer.observe(el)
    }

    return () => observer.disconnect()
  }, [headings])

  if (headings.length < 2) return null

  return (
    <nav className="hidden xl:block sticky top-6 w-56 shrink-0">
      <p className="text-xs font-semibold text-muted-foreground mb-3">
        On this page
      </p>
      <ul className="space-y-1.5 text-xs">
        {headings.map((heading) => (
          <li key={heading.id}>
            <a
              href={`#${heading.id}`}
              onClick={(e) => {
                e.preventDefault()
                document.getElementById(heading.id)?.scrollIntoView({
                  behavior: 'smooth',
                })
              }}
              className={cn(
                'block transition-colors hover:text-foreground',
                heading.level === 3 && 'pl-3',
                activeId === heading.id
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground',
              )}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
