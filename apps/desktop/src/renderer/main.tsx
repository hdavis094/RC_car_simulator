import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './shell/index.ts';

const container = document.getElementById('root');
if (!container) throw new Error('index.html has no #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
