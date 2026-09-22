import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so the same dist serves from wallet.ferminux.net AND https://ferminux.net/wallet/
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
