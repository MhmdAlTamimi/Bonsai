import { useEffect, useRef, useState } from 'react';

import { subscribe } from '../api/client.ts';
import { appendDelta } from './deltaBuffer.ts';
import type { Delta } from '../panel/chat/liveMerge.ts';

/**
 * The live event stream for a project, and the run output it carries.
 *
 * Two jobs that arrive down one wire: text to show as it is produced, and
 * "something changed, refetch the tree". Keeping them together means the
 * subscription is opened once per project rather than once per consumer.
 *
 * Each delta is kept WHOLE -- its run and its sequence number as well as its
 * text. This used to store the text alone, which threw away the only two
 * fields that say where a delta belongs, and left the transcript guessing by
 * array position instead. See liveMerge.ts for what that guess cost.
 */
export function useRunStream(
  projectId: string | null,
  onTreeChanged: () => void,
): {
  streams: Record<string, Delta[]>;
  health: 'connecting' | 'live' | 'reconnecting';
  revision: number;
  /**
   * Bumped only when a run reports an error.
   *
   * The connection gate records authentication and rate failures as they are
   * reported by runs, so the app has to re-read it after one -- but ONLY after
   * one. This used to ride on `revision`, which every status change and every
   * finished run bumps, so a busy tree re-fetched the connection and the whole
   * settings object several times a second and replaced both on every arrival.
   */
  agentRevision: number;
} {
  // Live run output, keyed by node. Cleared when a run starts so a second run
  // does not read as a continuation of the first.
  const [streams, setStreams] = useState<Record<string, Delta[]>>({});

  /**
   * The refetch callback behind a ref.
   *
   * Without it, every refetch that changes the callback's identity would tear
   * the EventSource down and open a new one -- losing whatever was streaming
   * at that moment, several times a second while an agent is working.
   */
  const [health, setHealth] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [revision, setRevision] = useState(0);
  const [agentRevision, setAgentRevision] = useState(0);
  const notify = useRef(onTreeChanged);
  notify.current = onTreeChanged;

  useEffect(() => {
    setStreams({});
    setHealth('connecting');
    if (projectId === null) return;
    const add = (nodeId: string, delta: Delta): void => {
      setStreams((prev) => {
        const existing = prev[nodeId] ?? [];
        const next = appendDelta(existing, delta);
        return next === existing ? prev : { ...prev, [nodeId]: [...next] };
      });
    };

    return subscribe(
      projectId,
      (event) => {
        switch (event.type) {
          case 'run.started':
            setStreams((prev) => ({ ...prev, [event.nodeId]: [] }));
            break;
          case 'run.delta':
            add(event.nodeId, {
              runId: event.runId,
              seq: event.seq,
              text: event.text,
              ...(event.tool ? { tool: event.tool } : {}),
            });
            break;
          case 'run.error':
            // seq 0 marks output that is published but never persisted, so the
            // transcript keeps showing it rather than waiting for a row that is
            // not coming.
            add(event.nodeId, { runId: event.runId, seq: 0, text: event.error });
            setAgentRevision((n) => n + 1);
            setRevision((n) => n + 1);
            notify.current();
            break;
          // run.question is here rather than in a case of its own because the
          // tree already carries the question (NodeView.pendingQuestion) -- this
          // only has to say "look again". It has to say it promptly, though: the
          // agent is stopped until someone answers.
          case 'tree.updated':
          case 'node.status':
          case 'run.question':
          case 'run.finished':
            setRevision((n) => n + 1);
            notify.current();
            break;
          default:
            break;
        }
      },
      (state) => {
        setHealth(state);
        if (state === 'live') {
          setRevision((n) => n + 1);
          // A transport gap can hide a failure the gate recorded while the
          // stream was down, so reconciling after one includes the credential.
          setAgentRevision((n) => n + 1);
          notify.current();
        }
      },
    );
  }, [projectId]);

  return { streams, health, revision, agentRevision };
}
