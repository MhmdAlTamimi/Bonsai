import type { JSX } from 'react';

import { parseMarkdown, type Block, type Inline } from './markdown.ts';

/**
 * An agent reply, rendered as the markdown it is.
 *
 * Elements, never `dangerouslySetInnerHTML`. The text comes from a model that
 * has been reading files out of a repository, so treating it as markup would
 * make the transcript the one place in this app where content nobody wrote
 * becomes executable. React escaping it is the whole defence, and it is free.
 */
export function Markdown({ source }: { source: string }): JSX.Element {
  const blocks = parseMarkdown(source);
  // An empty reply is possible (a run that only made tool calls). Render
  // nothing rather than an empty block that takes up a line.
  if (blocks.length === 0) return <></>;
  return (
    <div className="md">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}

function BlockView({ block }: { block: Block }): JSX.Element {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p>
          <InlineList content={block.content} />
        </p>
      );
    case 'heading': {
      const Tag = `h${block.level + 3}` as 'h4' | 'h5' | 'h6';
      // Offset by three so a reply's `#` is an h4: the panel's own headings are
      // h2/h3, and a reply must not outrank the node it belongs to.
      return (
        <Tag className={`md-h${block.level}`}>
          <InlineList content={block.content} />
        </Tag>
      );
    }
    case 'code':
      return (
        <pre className="md-code" data-lang={block.lang ?? undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case 'list':
      return block.ordered ? (
        <ol>
          {block.items.map((item, i) => (
            <li key={i}>
              <InlineList content={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>
              <InlineList content={item} />
            </li>
          ))}
        </ul>
      );
    case 'quote':
      return (
        <blockquote>
          <InlineList content={block.content} />
        </blockquote>
      );
  }
}

function InlineList({ content }: { content: Inline[] }): JSX.Element {
  return (
    <>
      {content.map((node, i) => (
        <InlineView key={i} node={node} />
      ))}
    </>
  );
}

function InlineView({ node }: { node: Inline }): JSX.Element {
  switch (node.kind) {
    case 'text':
      return <>{node.text}</>;
    case 'code':
      return <code>{node.text}</code>;
    case 'strong':
      return (
        <strong>
          <InlineList content={node.children} />
        </strong>
      );
    case 'em':
      return (
        <em>
          <InlineList content={node.children} />
        </em>
      );
    case 'link':
      // The scheme is already restricted in the parser; noopener is for the
      // window reference, which is a different problem from the scheme.
      return (
        <a href={node.href} target="_blank" rel="noreferrer noopener">
          <InlineList content={node.children} />
        </a>
      );
  }
}
