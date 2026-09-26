// Vite config for the Ferminux Explorer (explorer.ferminux.net).
//
// Production: a static SPA. nginx serves dist/ and falls back to /index.html for every app route; /api,
// /api/v2/*, /api/v1/graphql and /socket/* stay on the index backend untouched (surfaces/explorer.md §13).
// Dev: the same-origin "/api/v2" base is proxied to the live index, so the client code has one base URL.
// `npm run dev:fixtures` answers /api/v2/* from fixtures/ instead (surfaces/explorer.md §1.5).
//
// This file is not part of `tsc --noEmit` (the app tsconfig has no Node types); esbuild strips it.
import { defineConfig, loadEnv, type Plugin } from "vite";
import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const INDEX = "https://explorer.ferminux.net";

/** VITE_FIXTURES=1: /api/v2/* from fixtures/index.json (URL -> file + recorded status). Exact URL first,
 *  then the path without its query; a miss is a 404 in the index's own shape, never a live call. */
function fixtures(): Plugin {
  return {
    name: "fx-fixtures",
    apply: "serve",
    configureServer(server) {
      if (process.env.VITE_FIXTURES !== "1") return;
      const dir = resolve(root, "fixtures");
      const idx = JSON.parse(readFileSync(resolve(dir, "index.json"), "utf8")) as { files: Record<string, { status: number; url: string }> };
      const byUrl = new Map<string, { file: string; status: number }>();
      const byPath = new Map<string, { file: string; status: number }>();
      for (const [file, v] of Object.entries(idx.files)) {
        if (!v.url.startsWith(INDEX + "/api/v2")) continue;
        const u = new URL(v.url);
        const key = decodeURIComponent(u.pathname + u.search).toLowerCase();
        byUrl.set(key, { file, status: v.status });
        const p = u.pathname.toLowerCase();
        if (!byPath.has(p) || !u.search) byPath.set(p, { file, status: v.status });
      }
      server.config.logger.info(`  fixtures: ${byUrl.size} index responses from fixtures/`, { timestamp: true });
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/api/v2/")) return next();
        const u = new URL(url, "http://x");
        // search answers depend on the query: never fall back to another query's recorded answer
        const search = /^\/api\/v2\/search(\/|$)/i.test(u.pathname);
        const hit = byUrl.get(decodeURIComponent(u.pathname + u.search).toLowerCase()) ?? (search ? undefined : byPath.get(u.pathname.toLowerCase()));
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("x-fixture", hit ? hit.file : "miss");
        if (!hit && search) {
          const p = u.pathname.toLowerCase();
          res.statusCode = 200;
          res.end(p.endsWith("/check-redirect") ? '{"redirect":false}' : p.endsWith("/quick") ? "[]" : '{"items":[],"next_page_params":null}');
          return;
        }
        if (!hit || !existsSync(resolve(dir, hit.file))) { res.statusCode = 404; res.end('{"message":"Not found"}'); return; }
        res.statusCode = hit.status;
        res.end(readFileSync(resolve(dir, hit.file)));
      });
    },
  };
}

/** A copy of index.html as 404.html, for static hosts that serve it on unknown paths. nginx uses
 *  `error_page 404 /index.html` with a real 404 status instead (§13); the app renders its own 404 page. */
function spa404(): Plugin {
  let out = resolve(root, "dist");
  return {
    name: "fx-spa-404",
    apply: "build",
    // the build's real output directory (a --outDir build must get its 404.html too)
    configResolved(c) { out = resolve(c.root, c.build.outDir); },
    closeBundle() {
      if (existsSync(resolve(out, "index.html"))) copyFileSync(resolve(out, "index.html"), resolve(out, "404.html"));
    },
  };
}

/** validators.html: the same shell once more, written only when the Step 1 validator pages are switched on,
 *  decided exactly as src/validators/config.ts decides VALIDATORS_ENABLED (VITE_VALIDATOR_HUB and
 *  VITE_VALIDATOR_HUB_LENS, else validatorHub and validatorHubLens in the address book). nginx serves /validators
 *  and /validators/:id from this file, so in a build without the hub those paths stay real 404s
 *  (deploy/proxy/default.conf). The file is a byte copy, so the CSP hash of index.html's inline script holds. */
function validatorsShell(env: Record<string, string>): Plugin {
  let out = resolve(root, "dist");
  return {
    name: "fx-validators-shell",
    apply: "build",
    configResolved(c) { out = resolve(c.root, c.build.outDir); },
    closeBundle() {
      const book = JSON.parse(readFileSync(resolve(root, "src/data/contracts.3961.json"), "utf8")) as { validatorHub?: string | null; validatorHubLens?: string | null };
      const hub = env.VITE_VALIDATOR_HUB || book.validatorHub || null;
      const lens = env.VITE_VALIDATOR_HUB_LENS || book.validatorHubLens || null;
      if (hub && lens && existsSync(resolve(out, "index.html"))) copyFileSync(resolve(out, "index.html"), resolve(out, "validators.html"));
    },
  };
}

export default defineConfig(({ mode }) => ({
  appType: "spa", // dev + preview: every non-file path falls back to index.html (History API routing)
  base: "/",      // root-relative assets, so /tx/0x…/ deep links load the same bundle
  plugins: [fixtures(), spa404(), validatorsShell(loadEnv(mode, root, "VITE_"))],
  build: {
    target: "es2022",
    cssCodeSplit: true,
    assetsInlineLimit: 0, // fonts stay files: preloadable, cacheable, CSP font-src 'self'
    rollupOptions: {
      output: {
        // ethers only ever loads inside the lazy recover/decode chunks; keep it in its own file.
        // ethers splits by use: the signature recovery (recover.ts, RPC-fallback only) and the ABI coder (contract
        // tab) share only the hashing core, so neither path downloads the other's half.
        manualChunks: (id) => {
          // address/eth.ts (the lazy ethers entry of the contract tab) gets its own chunk: left alone, Rollup merges it
          // with the shared address-book helpers, which turns ethers into a static import of the address pages
          if (id.endsWith("/src/pages/address/eth.ts")) return "eth";
          if (!/node_modules\/(ethers|@noble)/.test(id)) return undefined;
          if (/ethers\/lib\.esm\/abi\//.test(id)) return "ethers-abi";
          return "ethers";
        },
      },
    },
  },
  server: {
    port: 4180,
    proxy: {
      // A regex key: "/api-docs" is an app route and must NOT be proxied, only /api, /api/, /api?….
      "^/api(/|\\?|$)": { target: INDEX, changeOrigin: true, secure: true },
      "^/socket/": { target: INDEX, changeOrigin: true, secure: true, ws: true },
    },
  },
  preview: {
    port: 4181,
    proxy: {
      "^/api(/|\\?|$)": { target: INDEX, changeOrigin: true, secure: true },
    },
  },
}));
