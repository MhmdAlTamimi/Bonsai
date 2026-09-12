/**
 * Just enough markdown to read an agent's reply.
 *
 * The transcript used to render every assistant message as `<pre>{text}</pre>`
 * with `font: inherit`, which is fine for the stand-in agent and wrong for a
 * real one: Claude writes headings, lists and fenced code, so the panel showed
 * literal `##` and triple backticks in preformatted sans-serif. Code in a reply
 * was the worst case -- unindented, unmonospaced, and wrapped mid-token.
 *
 * PARSING ONLY, and no JSX, so this file runs under `node --experimental-strip-types`
 * and can be tested without a bundler or a browser (see markdown.test.ts).
 * Markdown.tsx turns these blocks into elements.
 *
 * Deliberately small. Fenced code, headings, lists, quotes and four inline
 * forms cover almost everything an agent writes; tables, nested lists,
 * reference links and HTML do not appear often enough to justify either the
 * parser or a dependency (the project's rule is to ask before adding one).
 * Anything unrecognised falls through as text rather than disappearing, which
 * is the property that matters: an unsupported construct should look plain,
 * never empty.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] };

export type Block =
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; content: Inline[] }
  | { kind: 'code'; lang: string | null; text: string }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'quote'; content: Inline[] };

const FENCE = /^\s*```\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', content: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    /**
     * Fences first, and greedily: everything up to the closing fence is taken
     * verbatim, so a `# comment` or a `- item` inside a code block stays code
     * rather than being re-parsed as a heading or a list.
     */
    const fence = FENCE.exec(line);
    if (fence !== null) {
      flush();
      const lang = fence[1] === undefined || fence[1] === '' ? null : fence[1];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      // An unterminated fence still yields a code block. The agent's output can
      // be cut off mid-block by a cancel, and showing the partial code is more
      // use than showing the rest of the message as one long code line.
      blocks.push({ kind: 'code', lang, text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length as 1 | 2 | 3,
        content: parseInline(heading[2]!),
      });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      flush();
      const body: string[] = [quote[1]!];
      while (i + 1 < lines.length) {
        const next = QUOTE.exec(lines[i + 1]!);
        if (next === null) break;
        body.push(next[1]!);
        i += 1;
      }
      blocks.push({ kind: 'quote', content: parseInline(body.join('\n')) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet === null ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      flush();
      const isOrdered = bullet === null;
      const items: Inline[][] = [parseInline((bullet ?? ordered)![1]!)];
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1]!;
        const next = isOrdered ? ORDERED.exec(nextLine) : BULLET.exec(nextLine);
        if (next === null) break;
        items.push(parseInline(next[1]!));
        i += 1;
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }

    paragraph.push(line);
  }

  flush();
  return blocks;
}

/**
 * Inline spans, resolved left to right.
 *
 * `code` is matched before everything else and its contents are never re-parsed,
 * so `` `**not bold**` `` stays literal -- the case that matters most here,
 * because agents quote markdown syntax when explaining markdown.
 */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = '';

  const pushText = (): void => {
    if (text === '') return;
    out.push({ kind: 'text', text });
    text = '';
  };

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);

    const code = /^`([^`]+)`/.exec(rest);
    if (code !== null) {
      pushText();
      out.push({ kind: 'code', text: code[1]! });
      i += code[0].length;
      continue;
    }

    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (link !== null) {
      pushText();
      const href = safeHref(link[2]!);
      // A refused scheme renders as the label text rather than vanishing. The
      // user still sees what was written; it just is not clickable.
      out.push(
        href === null
          ? { kind: 'text', text: link[1]! }
          : { kind: 'link', href, children: parseInline(link[1]!) },
      );
      i += link[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (strong !== null) {
      pushText();
      out.push({ kind: 'strong', children: parseInline(strong[2]!) });
      i += strong[0].length;
      continue;
    }

    const em = /^(\*|_)(?=\S)([^*_]*?\S)\1/.exec(rest);
    if (em !== null) {
      pushText();
      out.push({ kind: 'em', children: parseInline(em[2]!) });
      i += em[0].length;
      continue;
    }

    text += source[i];
    i += 1;
  }

  pushText();
  return coalesce(out);
}

/**
 * Merge neighbouring text runs.
 *
 * The scanner emits one node per unmatched construct, so a line like
 * `[x](javascript:...)` -- refused, and with a stray bracket left over -- comes
 * out as several text nodes in a row. They render identically either way; this
 * keeps the renderer from emitting a span per character-run for no reason, and
 * makes the parser's output stable enough to assert on.
 */
function coalesce(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (node.kind === 'text' && last?.kind === 'text')
      out[out.length - 1] = { kind: 'text', text: last.text + node.text };
    else out.push(node);
  }
  return out;
}

/**
 * Only http(s) and mailto survive.
 *
 * The transcript renders text produced by a model, which in turn read files
 * from a repository -- so a `javascript:` or `data:` href is reachable from
 * content nobody in this app wrote. Cheap to refuse, and refusing keeps the
 * renderer from being the one place untrusted input becomes executable.
 */
function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null;
}
