import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectApp } from './ConnectApp.tsx';
import '../styles.css';
import './connect.css';
// The wallet's chosen theme (Settings → Appearance) applies here too.
import '../views/prefs.ts';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConnectApp />
  </React.StrictMode>,
);
