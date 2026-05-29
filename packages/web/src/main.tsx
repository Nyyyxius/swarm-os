import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import './styles/desktop-theme.css';
import { applyCachedInstanceSettings } from './hooks/useInstanceSettings';

// Apply the cached instance theme BEFORE React renders so the first paint
// already has the operator's chosen accent / label / bg-tint / density.
// The hook later reconciles with the server's value.
applyCachedInstanceSettings();

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Phase 6 — register the service worker for PWA install + offline shell.
// Production-only: in dev, Vite serves modules from /src/* with HMR, and a SW
// would happily cache them and break hot-reload. The SW itself is at /sw.js
// (served from packages/web/public/sw.js by Vite — copied to dist/ at build).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      // Non-fatal: the app works fine without the SW. Surface in console so
      // PWA-related regressions are visible during smoke tests.
      console.warn('[swarm-os] service worker registration failed:', err);
    });
  });
}
