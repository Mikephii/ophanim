import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark-dimmed.css'
import type { ComponentPropsWithoutRef } from 'react'

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
}

/** Custom heading components that add id attributes for TOC anchor links */
function createHeading(level: number) {
  function Heading({ children, ...props }: ComponentPropsWithoutRef<'h1'>) {
    const text = typeof children === 'string' ? children : String(children)
    const id = slugify(text)
    const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
    return (
      <Tag id={id} {...props}>
        {children}
      </Tag>
    )
  }
  Heading.displayName = `Heading${level}`
  return Heading
}

const headingComponents = {
  h1: createHeading(1),
  h2: createHeading(2),
  h3: createHeading(3),
  h4: createHeading(4),
  h5: createHeading(5),
  h6: createHeading(6),
}

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={headingComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
