import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { bootPlatform, markAppReady } from './platform/index.ts';
import './styles.css';

// In the app, the stored vault is read out of the Keystore/Keychain store
// before the first render (state/storage.ts reads it synchronously). On the
// web this resolves at once.
void bootPlatform().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  requestAnimationFrame(() => markAppReady());
});
