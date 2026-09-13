import { useEffect, useRef, useState } from 'react';

import { subscribe } from '../api/client.ts';
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
): Record<string, Delta[]> {
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
  const notify = useRef(onTreeChanged);
  notify.current = onTreeChanged;

  useEffect(() => {
    if (projectId === null) return;
    const append = (nodeId: string, delta: Delta): void => {
      setStreams((prev) => ({ ...prev, [nodeId]: [...(prev[nodeId] ?? []), delta] }));
    };

    return subscribe(projectId, (event) => {
      switch (event.type) {
        case 'run.started':
          setStreams((prev) => ({ ...prev, [event.nodeId]: [] }));
          break;
        case 'run.delta':
          append(event.nodeId, { runId: event.runId, seq: event.seq, text: event.text });
          break;
        case 'run.error':
          // seq 0 marks output that is published but never persisted, so the
          // transcript keeps showing it rather than waiting for a row that is
          // not coming.
          append(event.nodeId, { runId: event.runId, seq: 0, text: event.error });
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
          notify.current();
          break;
        default:
          break;
      }
    });
  }, [projectId]);

  return streams;
}
