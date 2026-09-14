import { createContext, useContext } from 'react';
export const RunAvailability = createContext(true);
export const useCanRun = (): boolean => useContext(RunAvailability);
