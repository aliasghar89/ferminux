import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so the same dist serves from stake.ferminux.net AND https://ferminux.net/stake/
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
