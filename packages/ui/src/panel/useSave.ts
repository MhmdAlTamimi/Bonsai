import { useRef, useState } from 'react';
import { describeError } from '../api/describeError.ts';

export function useSave() {
  const locked = useRef(false);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    if (locked.current) return false;
    locked.current = true;
    setState('saving');
    setError(null);
    try {
      await action();
      setState('saved');
      return true;
    } catch (e) {
      setError(describeError(e));
      setState('failed');
      return false;
    } finally {
      locked.current = false;
    }
  };
  return {
    state,
    error,
    busy: state === 'saving',
    run,
    reset: () => {
      setState('idle');
      setError(null);
    },
  };
}
