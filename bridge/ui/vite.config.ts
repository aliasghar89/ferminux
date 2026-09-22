import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so one dist serves from bridge.ferminux.net AND
// https://ferminux.net/bridge/ without a rebuild.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
