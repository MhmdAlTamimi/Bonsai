import {
  type JSX,
  type KeyboardEvent,
  type RefObject,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { Icon } from '../../Icon.tsx';
import { STATUS_LABEL } from '../../nodeStatus.tsx';
import { useAnchoredAbove } from '../../useAnchoredAbove.ts';
import { useExperiments } from '../../state/experiments.ts';
import { referenceSize, useReferences } from '../../state/references.ts';
import type { Attachment } from './drafts.ts';
import { matchMentions, mentionAt, withoutMention } from './mentions.ts';

/**
 * `@` in a message box: the menu that offers what can be attached, and the
 * chips showing what is.
 *
 * Two kinds of thing, one gesture. A reference is text written on purpose; an
 * experiment is another node's work -- its conversation, committed changes and
 * notes -- which the agent looks up only if the request needs it. Where the
 * box does not take experiments (a comparison already has its experiments),
 * the menu simply offers references.
 */

interface Option extends Attachment {
  label: string;
  detail: string;
}

const run = (count: number): string => `${count} run${count === 1 ? '' : 's'}`;

/**
 * The menu, and what the box needs to drive it. Keys are only taken while
 * there is something to choose, so `@property` followed by Enter still sends.
 */
export function useMentionMenu({
  value,
  onChange,
  attached,
  onAttach,
  box,
  experimentsFor,
}: {
  value: string;
  onChange: (value: string) => void;
  attached: readonly Attachment[];
  onAttach: (items: readonly Attachment[]) => void;
  box: RefObject<HTMLTextAreaElement | null>;
  /** The experiment this box belongs to, never offered to itself; omit to offer none. */
  experimentsFor?: string;
}): {
  menu: JSX.Element | null;
  textarea: Pick<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    | 'onSelect'
    | 'onFocus'
    | 'onBlur'
    | 'aria-autocomplete'
    | 'aria-controls'
    | 'aria-activedescendant'
  >;
  moved: (element: HTMLTextAreaElement) => void;
  keyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  begin: () => void;
} {
  const references = useReferences();
  const experiments = useExperiments();
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const id = useId();

  const typed = focused ? mentionAt(value, caret) : null;
  const mention = typed !== null && typed.start !== dismissedAt ? typed : null;
  const taken = new Set(attached.map((item) => `${item.kind}:${item.id}`));
  const groups: Array<{ title: string; options: Option[] }> = [];
  if (mention !== null) {
    const refs = matchMentions(
      references.list.filter((r) => !taken.has(`reference:${r.id}`)),
      mention.query,
    );
    if (refs.length > 0) {
      groups.push({
        title: 'References',
        options: refs.map((r) => ({
          kind: 'reference',
          id: r.id,
          label: r.name,
          detail: `${referenceSize(r.size)}${r.source === null ? '' : ` · from ${r.source.displayName}`}`,
        })),
      });
    }
    if (experimentsFor !== undefined) {
      const nodes = matchMentions(
        experiments.list
          .filter((n) => n.id !== experimentsFor && !taken.has(`experiment:${n.id}`))
          .map((n) => ({ name: n.displayName, node: n })),
        mention.query,
      );
      if (nodes.length > 0) {
        groups.push({
          title: 'Experiments',
          options: nodes.map(({ node }) => ({
            kind: 'experiment',
            id: node.id,
            label: node.displayName,
            detail: `${STATUS_LABEL[node.status]} · ${run(node.runCount)}`,
          })),
        });
      }
    }
  }
  // One list for the keys, whatever group an option is shown in.
  const options = groups.flatMap((group) => group.options);
  const current = Math.min(active, Math.max(0, options.length - 1));
  // The box grows with the text, so its top moves as it is typed in.
  const anchor = useAnchoredAbove(box, mention !== null, 'stretch', value);

  useEffect(() => setActive(0), [mention?.start, mention?.query]);
  // Put the caret where a change meant it to be, once the text has rendered.
  useLayoutEffect(() => {
    const element = box.current;
    if (pendingCaret.current === null || element === null) return;
    element.setSelectionRange(pendingCaret.current, pendingCaret.current);
    setCaret(pendingCaret.current);
    pendingCaret.current = null;
  }, [value, box]);

  const pick = (option: Option): void => {
    if (mention === null) return;
    const next = withoutMention(value, mention, caret);
    pendingCaret.current = next.caret;
    onChange(next.text);
    onAttach([...attached, { kind: option.kind, id: option.id }]);
  };

  const nothing =
    experimentsFor === undefined && references.list.length === 0
      ? 'No references in this project yet.'
      : `Nothing matches “${mention?.query ?? ''}”.`;
  const menu =
    mention === null || anchor === null ? null : (
      <div
        className="menu-panel anchored mention-menu"
        role="listbox"
        id={id}
        aria-label={experimentsFor === undefined ? 'References' : 'References and experiments'}
        style={anchor}
      >
        {options.length === 0 ? (
          <p className="mention-empty">
            {nothing}{' '}
            <button
              className="linkish"
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => references.open({ kind: 'library' })}
            >
              Open references
            </button>
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.title} role="group" aria-label={group.title}>
              {groups.length > 1 && <div className="menu-label">{group.title}</div>}
              {group.options.map((option) => {
                const index = options.indexOf(option);
                return (
                  <div
                    key={`${option.kind}:${option.id}`}
                    id={`${id}-${index}`}
                    role="option"
                    aria-selected={index === current}
                    className="mention-option"
                    // Keep the caret in the box; the choice is made on click.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => pick(option)}
                  >
                    <span className="mention-name">
                      <Icon name={option.kind} />
                      {option.label}
                    </span>
                    <small>{option.detail}</small>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    );

  return {
    menu,
    textarea: {
      onSelect: (e) => setCaret(e.currentTarget.selectionStart),
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
      'aria-autocomplete': 'list',
      'aria-controls': mention === null ? undefined : id,
      'aria-activedescendant': options.length === 0 ? undefined : `${id}-${current}`,
    },
    moved: (element) => {
      setCaret(element.selectionStart);
      // A dismissed menu stays dismissed while that mention is typed on.
      if (mentionAt(element.value, element.selectionStart) === null) setDismissedAt(null);
    },
    keyDown: (e) => {
      if (mention === null || e.nativeEvent.isComposing) return false;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissedAt(mention.start);
        return true;
      }
      if (options.length === 0) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((current + step + options.length) % options.length);
        return true;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        const chosen = options[current];
        if (chosen !== undefined) pick(chosen);
        return true;
      }
      return false;
    },
    begin: () => {
      const element = box.current;
      if (element === null) return;
      const at = element.selectionStart;
      const before = value.slice(0, at);
      const insert = before === '' || /\s$/.test(before) ? '@' : ' @';
      pendingCaret.current = at + insert.length;
      setDismissedAt(null);
      onChange(before + insert + value.slice(at));
      element.focus();
    },
  };
}

/**
 * What goes with the next message, as chips above the box. A reference says
 * how big it is; an experiment says how far along it is. Either can be opened
 * or removed. Something deleted after it was attached simply stops showing.
 */
export function AttachedChips({
  attached,
  onAttach,
}: {
  attached: readonly Attachment[];
  onAttach: (items: readonly Attachment[]) => void;
}): JSX.Element | null {
  const references = useReferences();
  const experiments = useExperiments();
  const chips = attached.flatMap((item) => {
    if (item.kind === 'reference') {
      const reference = references.byId.get(item.id);
      return reference === undefined
        ? []
        : [
            {
              item,
              name: reference.name,
              detail: referenceSize(reference.size),
              title: 'Open this reference',
              open: () => references.open({ kind: 'edit', id: reference.id }),
            },
          ];
    }
    const node = experiments.byId.get(item.id);
    return node === undefined
      ? []
      : [
          {
            item,
            name: node.displayName,
            detail: run(node.runCount),
            title: 'Go to this experiment',
            open: () => experiments.open(node.id),
          },
        ];
  });
  if (chips.length === 0) return null;
  return (
    <ul className="attached-references" aria-label="Attached to this message">
      {chips.map(({ item, name, detail, title, open }) => (
        <li key={`${item.kind}:${item.id}`} className={`reference-chip kind-${item.kind}`}>
          <Icon name={item.kind} />
          <button className="reference-chip-name" title={title} onClick={open}>
            @{name}
          </button>
          <small>{detail}</small>
          <button
            className="reference-chip-remove"
            aria-label={`Remove @${name}`}
            onClick={() =>
              onAttach(attached.filter((a) => a.kind !== item.kind || a.id !== item.id))
            }
          >
            <Icon name="close" />
          </button>
        </li>
      ))}
    </ul>
  );
}
