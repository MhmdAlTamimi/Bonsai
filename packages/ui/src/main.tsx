import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './App.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');
createRoot(container).render(
  <StrictMode>
    {/* Outside <Root/> so a throw anywhere in the app, the canvas and the
        panel included, still lands somewhere that can say what happened. */}
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
);
