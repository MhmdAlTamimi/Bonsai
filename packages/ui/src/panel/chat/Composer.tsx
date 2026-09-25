import {
  type JSX,
  type KeyboardEvent,
  type RefObject,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useCanRun } from '../../state/RunAvailability.ts';
import type { NextRunSettings, NodeView, ReferenceView } from '@bonsai/shared';
import { PERMISSIONS } from '../AgentFields.tsx';
import { useDismiss } from '../../useDismiss.ts';
import { Icon } from '../../Icon.tsx';
import { referenceSize, useReferences } from '../../state/references.ts';
import { matchMentions, mentionAt, withoutMention } from './mentions.ts';

/** How many lines the box grows to before it scrolls inside itself. */
const MAX_LINES = 5;

/** One submission surface, with a compact question entry for read-only experiments. */
export function Composer({
  node,
  busy,
  sending,
  value,
  onChange,
  onSend,
  attached,
  onAttach,
  nextRun,
  onProjectSettings,
}: {
  node: NodeView;
  /** A run is in flight, or the node is parked on a question. */
  busy: boolean;
  sending: boolean;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** References going with the next message, by id, in the order they were added. */
  attached: readonly string[];
  onAttach: (ids: readonly string[]) => void;
  /** What the next run would use, behind the row's ⋯ — settings, not conversation. */
  nextRun?: NextRunSettings | null;
  onProjectSettings?: () => void;
}): JSX.Element {
  const canRun = useCanRun();
  const initial = node.status === 'new';
  const frozen = !node.writable;
  const [open, setOpen] = useState(!frozen);
  const ref = useRef<HTMLTextAreaElement>(null);
  const mention = useMentionMenu(value, onChange, attached, onAttach, ref);

  /**
   * The box grows with the draft, to five lines, and then scrolls inside
   * itself — the one place in the panel allowed its own scroll, because Send
   * must never be pushed out of the window by something you are typing.
   */
  useLayoutEffect(() => {
    const box = ref.current;
    if (box === null) return;
    const style = getComputedStyle(box);
    const line = Number.parseFloat(style.lineHeight) || 20;
    const padding =
      Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) || 0;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, Math.round(line * MAX_LINES + padding))}px`;
  }, [value, open]);

  // Re-collapse when moving to another frozen node, so the panel does not stay
  // expanded because of a decision made about a different node.
  useEffect(() => {
    setOpen(!frozen);
  }, [node.id, frozen]);

  if (frozen && !open && !initial) {
    return (
      <div className="composer collapsed">
        <button
          className="composer-open"
          onClick={() => {
            setOpen(true);
            setTimeout(() => ref.current?.focus(), 0);
          }}
        >
          Ask a question&hellip;
        </button>
        <span className="hint">
          {node.frozenReason === 'your_folder'
            ? 'Read only — your own folder'
            : 'Frozen — a child committed'}
        </span>
      </div>
    );
  }

  return (
    <div className="composer">
      <AttachedReferences attached={attached} onAttach={onAttach} />
      {mention.menu}
      <textarea
        ref={ref}
        value={value}
        {...mention.textarea}
        onChange={(e) => {
          onChange(e.target.value);
          mention.moved(e.target);
        }}
        onKeyDown={(e) => {
          if (mention.keyDown(e)) return;
          // Enter sends; Shift+Enter is a newline, as in any chat box.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canRun && !busy && !sending && value.trim()) onSend();
          }
        }}
        placeholder={initial ? 'Describe what the first run should do…' : placeholder(node, busy)}
        rows={1}
        aria-label="message"
      />
      <div className="composer-row">
        <span className="hint">
          {frozen
            ? node.frozenReason === 'your_folder'
              ? 'Read only — questions only'
              : 'Frozen — questions only'
            : canRun
              ? '⏎ send · ⇧⏎ newline'
              : 'Reconnect the agent to send'}
        </span>
        <button
          className="composer-mention"
          aria-label="Attach a reference"
          title="Attach a reference — or type @"
          onClick={mention.begin}
        >
          @
        </button>
        {nextRun != null && <NextRun value={nextRun} onProjectSettings={onProjectSettings} />}
        <button
          className="primary"
          onClick={onSend}
          disabled={!canRun || busy || sending || value.trim() === ''}
          aria-label={initial ? 'Start first run' : 'Send'}
        >
          <span className="send-label">
            {sending ? (initial ? 'Starting…' : 'Sending…') : initial ? 'Start first run' : 'Send'}
          </span>
          {/* Shown instead of the label when the panel is too narrow to hold
              a hint and two buttons — the design's other composer. */}
          <span className="send-arrow" aria-hidden="true">
            ↑
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * The references going with the next message, as chips above the box. Each
 * says how big it is, since every one is something the agent will read.
 */
function AttachedReferences({
  attached,
  onAttach,
}: {
  attached: readonly string[];
  onAttach: (ids: readonly string[]) => void;
}): JSX.Element | null {
  const { byId, open } = useReferences();
  // A reference deleted after it was attached simply stops being attached.
  const shown = attached.flatMap((id) => byId.get(id) ?? []);
  if (shown.length === 0) return null;
  return (
    <ul className="attached-references" aria-label="References attached to this message">
      {shown.map((reference) => (
        <li key={reference.id} className="reference-chip">
          <button
            className="reference-chip-name"
            title="Open this reference"
            onClick={() => open({ kind: 'edit', id: reference.id })}
          >
            @{reference.name}
          </button>
          <small>{referenceSize(reference.size)}</small>
          <button
            className="reference-chip-remove"
            aria-label={`Remove @${reference.name}`}
            onClick={() => onAttach(attached.filter((id) => id !== reference.id))}
          >
            <Icon name="close" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Typing `@` offers the project's references; choosing one turns what was
 * typed into a chip. Keys are only taken while there is something to choose,
 * so `@property` followed by Enter still sends.
 */
function useMentionMenu(
  value: string,
  onChange: (value: string) => void,
  attached: readonly string[],
  onAttach: (ids: readonly string[]) => void,
  box: RefObject<HTMLTextAreaElement | null>,
): {
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
  const { list, open: openReference } = useReferences();
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const id = useId();

  const typed = focused ? mentionAt(value, caret) : null;
  const mention = typed !== null && typed.start !== dismissedAt ? typed : null;
  const matches =
    mention === null
      ? []
      : matchMentions(
          list.filter((reference) => !attached.includes(reference.id)),
          mention.query,
        );
  const current = Math.min(active, Math.max(0, matches.length - 1));
  const anchor = useAnchor(box, mention !== null, value);

  useEffect(() => setActive(0), [mention?.start, mention?.query]);
  // Put the caret where a change meant it to be, once the text has rendered.
  useLayoutEffect(() => {
    const element = box.current;
    if (pendingCaret.current === null || element === null) return;
    element.setSelectionRange(pendingCaret.current, pendingCaret.current);
    setCaret(pendingCaret.current);
    pendingCaret.current = null;
  }, [value, box]);

  const pick = (reference: ReferenceView): void => {
    if (mention === null) return;
    const next = withoutMention(value, mention, caret);
    pendingCaret.current = next.caret;
    onChange(next.text);
    onAttach([...attached, reference.id]);
  };

  const menu =
    mention === null || anchor === null
      ? null
      : createPortal(
          <div
            className="menu-panel mention-menu"
            role="listbox"
            id={id}
            aria-label="References"
            style={anchor}
          >
            {matches.length === 0 ? (
              <p className="mention-empty">
                {list.length === 0
                  ? 'No references in this project yet.'
                  : `No reference matches “${mention.query}”.`}{' '}
                <button
                  className="linkish"
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => openReference({ kind: 'library' })}
                >
                  Open references
                </button>
              </p>
            ) : (
              matches.map((reference, index) => (
                <div
                  key={reference.id}
                  id={`${id}-${index}`}
                  role="option"
                  aria-selected={index === current}
                  className="mention-option"
                  // Keep the caret in the box; the choice is made on click.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(reference)}
                >
                  <span className="mention-name">@{reference.name}</span>
                  <small>
                    {referenceSize(reference.size)}
                    {reference.source !== null && ` · from ${reference.source.displayName}`}
                  </small>
                </div>
              ))
            )}
          </div>,
          document.body,
        );

  return {
    menu,
    textarea: {
      onSelect: (e) => setCaret(e.currentTarget.selectionStart),
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
      'aria-autocomplete': 'list',
      'aria-controls': mention === null ? undefined : id,
      'aria-activedescendant': matches.length === 0 ? undefined : `${id}-${current}`,
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
      if (matches.length === 0) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((current + step + matches.length) % matches.length);
        return true;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        const chosen = matches[current];
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
 * Where the `@` menu sits: just above the box, as wide as it.
 *
 * Fixed to the window rather than placed inside the composer, because the
 * panel's foot scrolls in its exceptional states and would clip anything that
 * rises out of it -- which is where a menu over the thread has to be.
 */
function useAnchor(
  box: RefObject<HTMLTextAreaElement | null>,
  open: boolean,
  value: string,
): { left: number; width: number; bottom: number } | null {
  const [anchor, setAnchor] = useState<{ left: number; width: number; bottom: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const element = box.current;
    if (!open || element === null) {
      setAnchor(null);
      return;
    }
    const measure = (): void => {
      const rect = element.getBoundingClientRect();
      setAnchor({ left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + 6 });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // The box grows with the text, so its top moves as it is typed in.
  }, [box, open, value]);
  return anchor;
}

/**
 * What the next run would use, one ⋯ away from the box that starts it.
 *
 * It used to be a disclosure parked under the thread, where it described a run
 * that had not happened yet in the middle of the ones that had. Nothing is
 * decided here: the menu says what is set and offers the settings that set it.
 */
function NextRun({
  value,
  onProjectSettings,
}: {
  value: NextRunSettings;
  onProjectSettings?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    useCallback(() => setOpen(false), []),
    holder,
    '[aria-haspopup]',
  );
  return (
    <div className="menu composer-menu" ref={holder}>
      <button
        className="composer-more"
        aria-label="Settings for the next run"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Next run · ${value.model ?? 'Agent default'}`}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <div className="menu-panel right up next-run" role="menu">
          <div className="menu-label">Next run</div>
          <dl>
            <div>
              <dt>Model</dt>
              <dd>
                {value.model ?? 'Agent default'} <small>{value.modelSource}</small>
              </dd>
            </div>
            <div>
              <dt>Effort</dt>
              <dd>
                {value.effort ?? 'Agent default'} <small>{value.effortSource}</small>
              </dd>
            </div>
            <div>
              <dt>Permissions</dt>
              <dd>
                {PERMISSIONS[value.permissionMode]} <small>{value.permissionSource}</small>
              </dd>
            </div>
          </dl>
          {onProjectSettings && (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onProjectSettings();
              }}
            >
              Project settings…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function placeholder(node: NodeView, busy: boolean): string {
  if (node.status === 'needs_you') return 'Answer the question above to let it carry on.';
  if (busy) return 'The agent is working…';
  if (node.writable) return 'Reply, ask a question, or describe a change…';
  return node.frozenReason === 'your_folder'
    ? 'Your own folder — ask about it; branch a child to change anything.'
    : 'This node is frozen — you can still ask questions.';
}
