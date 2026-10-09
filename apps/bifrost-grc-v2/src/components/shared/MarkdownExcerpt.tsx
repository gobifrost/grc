import { memo, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownExcerptProps extends Omit<ComponentPropsWithoutRef<"span">, "children"> {
  source: string;
}

function Inline({ children }: { children?: ReactNode }) {
  return <>{children} </>;
}

const excerptComponents = {
  p: Inline,
  h1: Inline,
  h2: Inline,
  h3: Inline,
  h4: Inline,
  h5: Inline,
  h6: Inline,
  ul: Inline,
  ol: Inline,
  li: Inline,
  blockquote: Inline,
  pre: Inline,
  table: Inline,
  thead: Inline,
  tbody: Inline,
  tr: Inline,
  th: ({ children }: { children?: ReactNode }) => <>{children} · </>,
  td: ({ children }: { children?: ReactNode }) => <>{children} · </>,
  hr: () => <>— </>,
  img: ({ alt }: { alt?: string }) => <>{alt ? `[Image: ${alt}] ` : ""}</>,
};

/** Compact, markup-free-looking Markdown rendering for card summaries. */
const MarkdownExcerpt = memo(function MarkdownExcerpt({ source, className, ...props }: MarkdownExcerptProps) {
  return (
    <span className={className} {...props}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={excerptComponents}
      >
        {source}
      </ReactMarkdown>
    </span>
  );
});

export default MarkdownExcerpt;
