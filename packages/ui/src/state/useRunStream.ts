import { useEffect, useRef, useState } from 'react';

import { subscribe } from '../api/client.ts';

/**
 * The live event stream for a project, and the run output it carries.
 *
 * Two jobs that arrive down one wire: text to show as it is produced, and
 * "something changed, refetch the tree". Keeping them together means the
 * subscription is opened once per project rather than once per consumer.
 */
export function useRunStream(
  projectId: string | null,
  onTreeChanged: () => void,
): Record<string, string[]> {
  // Live run output, keyed by node. Cleared when a run starts so a second run
  // does not read as a continuation of the first.
  const [streams, setStreams] = useState<Record<string, string[]>>({});

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
    return subscribe(projectId, (event) => {
      switch (event.type) {
        case 'run.started':
          setStreams((prev) => ({ ...prev, [event.nodeId]: [] }));
          break;
        case 'run.delta':
          setStreams((prev) => ({
            ...prev,
            [event.nodeId]: [...(prev[event.nodeId] ?? []), event.text],
          }));
          break;
        case 'run.error':
          setStreams((prev) => ({
            ...prev,
            [event.nodeId]: [...(prev[event.nodeId] ?? []), event.error],
          }));
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
