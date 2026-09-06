import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './App.tsx';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');
createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
