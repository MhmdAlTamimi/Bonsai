import { createContext, useContext, useEffect, useRef, useState } from 'react';

/** Only live settings forms participate; credentials are never put in browser storage. */
export const SettingsDrafts = createContext<Set<symbol> | null>(null);

export function useSettingsDraft<T>(value: T): { saved: (next?: T) => void } {
  const drafts = useContext(SettingsDrafts);
  const id = useRef(Symbol('settings draft')).current;
  const serialized = JSON.stringify(value);
  const [baseline, setBaseline] = useState(serialized);
  useEffect(() => {
    if (serialized !== baseline) drafts?.add(id);
    else drafts?.delete(id);
    return () => {
      drafts?.delete(id);
    };
  }, [drafts, id, serialized, baseline]);
  return {
    saved: (next = value) => {
      drafts?.delete(id);
      setBaseline(JSON.stringify(next));
    },
  };
}
