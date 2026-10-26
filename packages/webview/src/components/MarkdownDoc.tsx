import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Generated docs are GitHub-flavoured markdown: tables, task lists, strikethrough. */
export function MarkdownDoc({ children }: { children: string }) {
  return <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>;
}
