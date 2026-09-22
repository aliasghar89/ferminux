import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so one dist serves from dex.ferminux.net AND https://ferminux.net/dex/.
//
// NOTE: this workstation reserves port 8602 for the DEX UI component; the e2e
// suite starts its anvil on the same port, so `npm run dev` and `npm run e2e`
// cannot run at the same time (the e2e checks the port is free and says so).
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      // The bridge panel reuses the bridge app's money-logic rather than
      // reimplementing it: quoting, caps, allowance rules, transfer ids, Sent
      // parsing. That code has its own suite and its own e2e against two
      // anvils, and a second copy here would drift from it silently — the
      // failure mode being a DEX that quotes a different net amount than the
      // bridge actually delivers.
      //
      // Only lib/ is reached for, never the bridge app's config: its CHAINS
      // list carries six chains and their RPC hosts, four of which have no
      // deployment. The two chains this panel uses are declared in
      // src/lib/bridgeChains.ts, where check-dist can see the hosts.
      '@bridge': fileURLToPath(new URL('../../bridge/ui/src', import.meta.url)),
    },
  },
  server: { port: 8602, strictPort: true },
  preview: { port: 8602, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
