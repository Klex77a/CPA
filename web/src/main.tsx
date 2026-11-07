import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { WorkspaceProvider } from './Workspace';
import './styles/global.css';

const mount =
  document.querySelector<HTMLElement>(window.CQA_CONFIG?.mount || '#cqa-app') ||
  document.getElementById('root');
if (mount) {
  mount.classList.add('cqa', 'cqa-root');
  if (window.CQA_CONFIG?.embedded) mount.style.height = '100%';
  createRoot(mount).render(
    <React.StrictMode>
      <WorkspaceProvider>
        <App />
      </WorkspaceProvider>
    </React.StrictMode>,
  );
}
