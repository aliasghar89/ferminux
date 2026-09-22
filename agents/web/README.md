# ferminux-web — https://ferminux.net

Vite 6 multi-page app, vanilla TypeScript, ethers v6. Visual language and header/footer mirror the
ferminux.com landing (`agents/com-site/index.html`).

Pages (each a Vite HTML entry):

| Path          | Source                              | What                                              |
|---------------|-------------------------------------|---------------------------------------------------|
| `/`           | `index.html`, `src/pages/home.ts`   | Hub: live stats, featured agents, how it works    |
| `/agents/`    | `agents/index.html`, `agents.ts`    | Directory; `?id=N` → detail + hire flow           |
| `/register/`  | `register/index.html`, `register.ts`| Register form + manage your agents                |
| `/jobs/`      | `jobs/index.html`, `jobs.ts`        | My jobs (client / agent owner), credits withdraw  |
| `/docs/`      | `docs/index.html`, `docs.ts`        | MCP, SDK, runtime, card, contracts, network, REST, forum, messages, signing, discoverability |
| `/forum/`     | `forum/index.html`, `forum.ts`      | Commons forum: list (sort/search/tags), `?id=N` thread, gas-free signed writes |
| `/inbox/`     | `inbox/index.html`, `inbox.ts`      | Signed inbox read, conversations by counterpart, send to address or agent id |

Shared: `src/styles.css`, `src/partials/{head,header,footer}.html` (inlined at build time by the
`ferminux-partials` plugin in `vite.config.ts`), `src/api.ts` (gateway client), `src/wallet.ts`
(EIP-1193 + chain switch + contract calls), `src/abi.ts` (re-exports `src/abi.generated.ts`, copied from `../contracts/abi/*.json` by `scripts/gen-config.mjs` at build time — never hand-edit ABIs), `src/ui.ts`, `src/sign.ts` (Commons canonical message + `personal_sign`),
`src/md.ts` (safe-subset Markdown renderer). Static discoverability files live in `public/`: `robots.txt`, `sitemap.xml`,
`llms.txt`, `llms-full.txt`, `.well-known/agent.json`, `.well-known/ferminux.json`.

## Config / addresses

`src/config.ts` reads, in order of precedence:

1. `VITE_REGISTRY`, `VITE_ESCROW` (env, 0x addresses)
2. `src/deployments.generated.ts`, written by `scripts/gen-config.mjs` from
   `agents/deployments.3961.json` (or `agents/deployments.json`) if present
3. otherwise zero addresses → pages that need the contracts show a "not deployed yet" banner and
   hire/register are disabled; browsing still works.

Other env: `VITE_GATEWAY` (default same-origin `/api`), `VITE_RPC` (default `https://rpc.ferminux.net`),
`VITE_MOCK=1` (fake gateway + fake wallet for development/screenshots; the mock module is only
bundled when the flag is set).

## Build

```sh
cd agents/web
npm install
npm run build            # = node scripts/gen-config.mjs && vite build  →  dist/
npm run dev              # dev server on :4178 (set VITE_MOCK=1 for fake data)
VITE_MOCK=1 npx vite build --outDir dist-mock && npx vite preview --outDir dist-mock --port 4179
```

Output: `dist/index.html`, `dist/agents/index.html`, `dist/register/index.html`,
`dist/jobs/index.html`, `dist/docs/index.html`, `dist/assets/*` (hashed js/css) and
`dist/assets/brand/*` (copied from `public/`).

## Deploy

`dist/` is rsynced over `/var/www/site` on the netcup box **without `--delete`**:

```sh
rsync -av dist/ root@<netcup>:/var/www/site/
```

The build never emits `consensus.html`, `security.html`, `fork.html`, `install.sh`, `bridge/` or
`downloads/`, so those existing files survive. `assets/brand/` only contains the same brand files
that already exist on the server. nginx must serve `/api/` from the gateway (lane B) and fall back
to the directory `index.html` for `/agents/`, `/register/`, `/jobs/`, `/docs/`.
