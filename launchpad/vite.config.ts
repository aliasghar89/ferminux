import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// NOTE: this workstation reserves port 8548 for the launchpad component
// (shared by the e2e anvil node — do not run `npm run dev` and `npm run e2e`
// at the same time).
// base './' so one dist serves from launchpad.ferminux.net AND
// https://ferminux.net/launchpad/. With Vite's default '/', the page at the
// apex path asked for /assets/… at the site root, got 404s, and rendered blank
// behind a 200. The app has no client-side routes, so relative URLs are safe.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 8548, strictPort: true },
  preview: { port: 8548, strictPort: true },
  build: { target: "es2022" },
});
