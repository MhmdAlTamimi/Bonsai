import { useEffect, useId, useRef, useState, type JSX, type RefObject } from 'react';
import type { DraftBasis, NodeView, ReferenceView } from '@bonsai/shared';

import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';
import { Dialog, DialogHeader } from '../../Dialog.tsx';
import { ErrorNote } from '../../ErrorNote.tsx';
import { Icon, IconButton } from '../../Icon.tsx';
import { useCanRun } from '../../state/RunAvailability.ts';
import {
  canDrawFrom,
  referenceSize,
  useReferences,
  type ReferenceTarget,
} from '../../state/references.ts';
import { exactTime, relativeTime } from '../chat/time.ts';
import { basisLine } from './basis.ts';

export type LibraryTarget = Exclude<ReferenceTarget, { kind: 'snapshot' }>;

/**
 * The project's references: the list, and one reference being written.
 *
 * One dialog for both because they are one task -- find the reference, or
 * write it -- and the way back from the editor is the list, not the map.
 * Saving returns to the list only when the list is where you came from.
 */
export function ReferencesDialog({
  target,
  projectId,
  projectName,
  nodes,
  onClose,
}: {
  target: LibraryTarget;
  projectId: string;
  projectName: string;
  nodes: readonly NodeView[];
  onClose: () => void;
}): JSX.Element {
  const { list, byId } = useReferences();
  const [view, setView] = useState<LibraryTarget>(target);
  const [fromLibrary, setFromLibrary] = useState(target.kind === 'library');
  const showLibrary = (): void => {
    setFromLibrary(true);
    setView({ kind: 'library' });
  };
  const done = (): void => (fromLibrary ? showLibrary() : onClose());

  return (
    <Dialog title="References" className="wide reference-dialog" onClose={onClose}>
      {view.kind === 'library' ? (
        <Library
          projectName={projectName}
          list={list}
          canDraft={nodes.some(canDrawFrom)}
          onOpen={(id) => setView({ kind: 'edit', id })}
          onNew={(draft) => setView({ kind: 'new', draft })}
          onClose={onClose}
        />
      ) : view.kind === 'edit' && !byId.has(view.id) ? (
        <Missing onBack={showLibrary} onClose={onClose} />
      ) : (
        <Editor
          // A different reference is a different form, not an edit of this one.
          key={view.kind === 'edit' ? view.id : 'new'}
          projectId={projectId}
          reference={view.kind === 'edit' ? (byId.get(view.id) ?? null) : null}
          seed={view.kind === 'new' ? view : { kind: 'new' }}
          nodes={nodes}
          onBack={showLibrary}
          onDone={done}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

function Library({
  projectName,
  list,
  canDraft,
  onOpen,
  onNew,
  onClose,
}: {
  projectName: string;
  list: readonly ReferenceView[];
  canDraft: boolean;
  onOpen: (id: string) => void;
  onNew: (draft: boolean) => void;
  onClose: () => void;
}): JSX.Element {
  const first = useFocusOnMount<HTMLButtonElement>();
  return (
    <>
      <DialogHeader
        title="References"
        subtitle={`${projectName} · give one to any experiment by typing @ in a message`}
        onClose={onClose}
      />
      <div className="reference-start">
        <button ref={first} className="primary" data-dialog-focus onClick={() => onNew(false)}>
          <Icon name="plus" /> New reference
        </button>
        <button
          disabled={!canDraft}
          title={canDraft ? undefined : 'No experiment has a conversation yet.'}
          onClick={() => onNew(true)}
        >
          New from a conversation
        </button>
      </div>
      {list.length === 0 ? (
        <p className="muted reference-empty">
          No references yet. A reference is text you write once — a test procedure, a result worth
          keeping — and hand to any experiment in this project.
        </p>
      ) : (
        <ul className="reference-list" aria-label="References">
          {list.map((reference) => (
            <li key={reference.id}>
              <button className="reference-row" onClick={() => onOpen(reference.id)}>
                <span className="reference-name">@{reference.name}</span>
                <span className="reference-meta">
                  {referenceSize(reference.size)}
                  {reference.source !== null
                    ? ` · from ${reference.source.displayName}`
                    : reference.comparison !== null &&
                      ` · from comparing ${reference.comparison.title}`}{' '}
                  ·{' '}
                  <time title={exactTime(reference.updatedAt)}>
                    {relativeTime(reference.updatedAt)}
                  </time>
                </span>
                <span className="reference-preview">{firstLine(reference.content)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** An edit opened for a reference that has since been deleted, here or elsewhere. */
function Missing({ onBack, onClose }: { onBack: () => void; onClose: () => void }): JSX.Element {
  return (
    <>
      <DialogHeader title="Reference not found" onClose={onClose} />
      <p className="muted">This reference is no longer in the project.</p>
      <div className="dialog-actions">
        <button className="primary" data-dialog-focus onClick={onBack}>
          All references
        </button>
      </div>
    </>
  );
}

/** A fill that can be taken back: what the box held, and where it was drawn from. */
interface Undo {
  content: string;
  sourceNodeId: string | null;
}

function Editor({
  projectId,
  reference,
  seed,
  nodes,
  onBack,
  onDone,
  onClose,
}: {
  projectId: string;
  /** The reference being edited, or null for a new one. */
  reference: ReferenceView | null;
  seed: Extract<LibraryTarget, { kind: 'new' }>;
  nodes: readonly NodeView[];
  onBack: () => void;
  /** Saved, deleted or cancelled: back to where the editor was opened from. */
  onDone: () => void;
  onClose: () => void;
}): JSX.Element {
  const [name, setName] = useState(reference?.name ?? '');
  const [content, setContent] = useState(reference?.content ?? seed.content ?? '');
  const [sourceNodeId, setSourceNodeId] = useState<string | null>(
    reference?.source?.id ?? seed.sourceNodeId ?? null,
  );
  // A comparison it is drawn from: fixed for this form, and what Fill reads.
  const comparison = seed.comparison ?? reference?.comparison ?? null;
  const [filling, setFilling] = useState(seed.draft === true);
  const [drafting, setDrafting] = useState(false);
  const [filled, setFilled] = useState<{ basis: DraftBasis; from: string; undo: Undo } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameField = useFocusOnMount<HTMLInputElement>();
  const contentLabel = useId();
  const locked = busy || drafting;

  const save = async (): Promise<void> => {
    if (locked || name.trim() === '' || content.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      if (reference === null) {
        await api.createReference(projectId, {
          name: name.trim(),
          content,
          sourceNodeId,
          sourceComparisonId: comparison?.id ?? null,
        });
      } else {
        await api.updateReference(reference.id, {
          name: name.trim(),
          content,
          ...(sourceNodeId === (reference.source?.id ?? null) ? {} : { sourceNodeId }),
        });
      }
      onDone();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (reference === null || locked) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteReference(reference.id);
      onDone();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader
        before={
          <button className="linkish reference-back" onClick={onBack} disabled={locked}>
            <Icon name="arrowLeft" /> All references
          </button>
        }
        title={reference === null ? 'New reference' : `Edit @${reference.name}`}
        onClose={onClose}
      />

      <label className="stacked">
        Name
        <input
          ref={nameField}
          data-dialog-focus
          value={name}
          disabled={busy}
          maxLength={80}
          aria-label="reference name"
          placeholder="e.g. smoke-test"
          onChange={(e) => setName(e.target.value)}
        />
        <span className="hint">Mention it in a message as @{name.trim() || 'name'}.</span>
      </label>

      <div className="reference-field">
        <div className="reference-field-head">
          <span id={contentLabel}>Content</span>
          <span className="hint">
            {referenceSize(content.length)}
            {sourceNodeId !== null
              ? ` · from ${nodes.find((node) => node.id === sourceNodeId)?.displayName ?? 'an experiment'}`
              : comparison !== null && ` · from comparing ${comparison.title}`}
          </span>
          {!filling && (
            <button className="linkish" disabled={locked} onClick={() => setFilling(true)}>
              Fill from a conversation
            </button>
          )}
        </div>
        {filling && (
          <Fill
            nodes={nodes}
            initialNodeId={sourceNodeId}
            comparison={comparison}
            current={content}
            disabled={busy}
            onDrafting={setDrafting}
            onFilled={(text, basis, nodeId) => {
              setFilled({
                basis,
                from:
                  nodeId === null
                    ? 'the comparison'
                    : (nodes.find((node) => node.id === nodeId)?.displayName ?? 'the experiment'),
                undo: { content, sourceNodeId },
              });
              setContent(text);
              if (nodeId !== null) setSourceNodeId(nodeId);
            }}
            onClose={() => setFilling(false)}
          />
        )}
        {filled !== null && (
          <p className="hint reference-basis" role="status">
            {basisLine(filled.basis, filled.from)}{' '}
            <button
              className="linkish"
              disabled={locked}
              onClick={() => {
                setContent(filled.undo.content);
                setSourceNodeId(filled.undo.sourceNodeId);
                setFilled(null);
              }}
            >
              Undo fill
            </button>
          </p>
        )}
        <textarea
          className="reference-text"
          value={content}
          disabled={locked}
          rows={12}
          aria-labelledby={contentLabel}
          placeholder="Steps to run, results to build on, what to avoid"
          onChange={(e) => setContent(e.target.value)}
        />
      </div>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        {confirmingDelete && reference !== null ? (
          <>
            <span className="hint">
              Delete @{reference.name}? Runs that already used it keep their copy.
            </span>
            <button disabled={busy} onClick={() => setConfirmingDelete(false)}>
              Keep it
            </button>
            <button
              className="destructive"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void remove()}
            >
              Delete reference
            </button>
          </>
        ) : (
          <>
            {reference !== null && (
              <button
                className="linkish danger reference-delete"
                disabled={locked}
                onClick={() => setConfirmingDelete(true)}
              >
                Delete
              </button>
            )}
            <span className="hint">
              {reference === null ? '' : 'Edits apply to runs from now on.'}
            </span>
            <button disabled={busy} onClick={onDone}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={locked || name.trim() === '' || content.trim() === ''}
              aria-busy={busy}
              onClick={() => void save()}
            >
              Save reference
            </button>
          </>
        )}
      </div>
    </>
  );
}

/** One click for the drafts people ask for most; anything else can be typed. */
const PRESETS = ['Summarise the results', 'Extract the test procedure', "List what didn't work"];

/**
 * Fill the reference from an experiment's conversation.
 *
 * One model call with no tools: it reads that experiment's conversation and
 * CONTEXT.md notes and writes text into the box, which is then yours to edit.
 * Nothing runs in the experiment, and nothing is saved until you save.
 */
function Fill({
  nodes,
  initialNodeId,
  comparison,
  current,
  disabled,
  onDrafting,
  onFilled,
  onClose,
}: {
  nodes: readonly NodeView[];
  /** The experiment offered first. Choosing another changes the source only once it fills. */
  initialNodeId: string | null;
  /** Draw from this comparison's conversation instead of an experiment's. */
  comparison: { id: string; title: string } | null;
  current: string;
  disabled: boolean;
  onDrafting: (drafting: boolean) => void;
  /** The experiment it was drawn from, or null for the comparison. */
  onFilled: (text: string, basis: DraftBasis, nodeId: string | null) => void;
  onClose: () => void;
}): JSX.Element {
  const canRun = useCanRun();
  const [nodeId, setNodeId] = useState(initialNodeId);
  const [instruction, setInstruction] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  // Closing the editor mid-draft stops the model call rather than paying for it.
  useEffect(() => () => controller.current?.abort(), []);

  const sources = nodes.filter((node) => canDrawFrom(node) || node.id === nodeId);
  const chosen = sources.find((node) => node.id === nodeId) ?? null;

  const fill = async (request: string): Promise<void> => {
    if (
      (comparison === null && chosen === null) ||
      request.trim() === '' ||
      controller.current !== null
    )
      return;
    const call = new AbortController();
    controller.current = call;
    setRunning(true);
    onDrafting(true);
    setError(null);
    try {
      const result = await api.draftReference(
        {
          ...(comparison !== null ? { comparisonId: comparison.id } : { nodeId: chosen!.id }),
          instruction: request.trim(),
          ...(current.trim() === '' ? {} : { current }),
        },
        call.signal,
      );
      onFilled(result.text, result.basis, comparison !== null ? null : chosen!.id);
    } catch (e) {
      if (!call.signal.aborted) setError(describeError(e));
    } finally {
      controller.current = null;
      setRunning(false);
      onDrafting(false);
    }
  };
  const run = (request: string): void => {
    setInstruction(request);
    void fill(request);
  };
  const off = disabled || running || !canRun || (comparison === null && chosen === null);

  return (
    <section className="reference-fill" aria-label="Fill from a conversation">
      <div className="reference-fill-head">
        <h4>Fill from a conversation</h4>
        <IconButton
          icon="close"
          size="sm"
          label="Hide fill from a conversation"
          disabled={running}
          onClick={onClose}
        />
      </div>
      {comparison === null && sources.length === 0 ? (
        <p className="muted">No experiment has a conversation yet.</p>
      ) : (
        <>
          {comparison !== null ? (
            <p className="reference-fill-source">
              From the comparison <strong>{comparison.title}</strong>
            </p>
          ) : (
            <label>
              Experiment
              <select
                value={chosen?.id ?? ''}
                disabled={disabled || running}
                aria-label="experiment to draw from"
                onChange={(e) => setNodeId(e.target.value === '' ? null : e.target.value)}
              >
                {chosen === null && <option value="">Choose an experiment</option>}
                {sources.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
          {running ? (
            <div className="reference-drafting">
              <span role="status">
                <span className="working-dot" aria-hidden="true" />
                {comparison !== null
                  ? 'Reading the comparison'
                  : `Reading ${chosen?.displayName ?? ''}’s conversation`}
              </span>
              <button onClick={() => controller.current?.abort()}>Cancel</button>
            </div>
          ) : (
            <>
              <div className="reference-presets">
                {PRESETS.map((preset) => (
                  <button key={preset} disabled={off} onClick={() => run(preset)}>
                    {preset}
                  </button>
                ))}
              </div>
              <div className="reference-ask">
                <input
                  value={instruction}
                  disabled={disabled || running}
                  aria-label="what to write"
                  placeholder="Or describe what to write"
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      if (!off) run(instruction);
                    }
                  }}
                />
                <button
                  disabled={off || instruction.trim() === ''}
                  onClick={() => run(instruction)}
                >
                  Fill
                </button>
              </div>
            </>
          )}
          <p className="hint">
            {canRun
              ? current.trim() === ''
                ? 'Writes into the box below from its conversation and notes. Nothing runs in the experiment.'
                : 'Revises the text below from its conversation and notes. You can undo it.'
              : 'Reconnect the agent to fill from a conversation.'}
          </p>
        </>
      )}
      {error !== null && <ErrorNote>{error}</ErrorNote>}
    </section>
  );
}

function firstLine(content: string): string {
  return content.trim().split('\n', 1)[0] ?? '';
}

/**
 * Focus an element when its view appears inside a dialog that is already open.
 * The dialog focuses `[data-dialog-focus]` itself when it first opens; this
 * covers moving between the list and the editor, which does not reopen it.
 */
function useFocusOnMount<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}
