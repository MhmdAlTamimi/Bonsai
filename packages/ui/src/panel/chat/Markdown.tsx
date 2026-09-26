import { useState, type JSX } from 'react';

import { CopyButton } from '../../CopyButton.tsx';
import { parseMarkdown, type Block, type Inline } from './markdown.ts';
import { Disclosure } from './Disclosure.tsx';

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
    <div className="markdown">
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
        <Tag className={`markdown-h${block.level}`}>
          <InlineList content={block.content} />
        </Tag>
      );
    }
    case 'code':
      return <CodeBlock text={block.text} lang={block.lang} />;
    case 'table':
      return <MdTable header={block.header} rows={block.rows} />;
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag>
          {block.items.map((item, i) => (
            <li key={i} className={item.checked === null ? undefined : 'markdown-task'}>
              {item.checked !== null && (
                <input
                  type="checkbox"
                  checked={item.checked}
                  disabled
                  aria-label={item.checked ? 'Checked' : 'Unchecked'}
                />
              )}
              <InlineList content={item.content} />
              {item.children.map((child, j) => (
                <BlockView key={j} block={child} />
              ))}
            </li>
          ))}
        </Tag>
      );
    }
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

/** How many rows a table shows before the rest is one disclosure away. */
const TABLE_ROWS = 6;

/**
 * A table, bounded like everything else in the panel.
 *
 * It used to be its own scroll region -- a scroller inside the panel's one
 * scroller, which is a trap: the wheel stops working where you happen to be
 * pointing. It clips to six rows instead and opens on the same row a tool
 * block uses.
 */
function MdTable({ header, rows }: { header: Inline[][]; rows: Inline[][][] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const hidden = Math.max(0, rows.length - TABLE_ROWS);
  const shown = open ? rows : rows.slice(0, TABLE_ROWS);
  return (
    <div className="markdown-table">
      <table>
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th key={i}>
                <InlineList content={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>
                  <InlineList content={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 && (
        <Disclosure open={open} lines={hidden} unit="row" onToggle={() => setOpen((v) => !v)} />
      )}
    </div>
  );
}

function CodeBlock({ text, lang }: { text: string; lang: string | null }): JSX.Element {
  return (
    <div className="markdown-code-block">
      <div className="code-actions">
        <span>{lang ?? 'Code'}</span>
        <CopyButton text={text} label="Copy code" />
      </div>
      <pre className="markdown-code" data-lang={lang ?? undefined}>
        <code>{text}</code>
      </pre>
    </div>
  );
}
