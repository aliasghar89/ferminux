# Deploying the explorer front end (explorer.ferminux.net)

This is the production switch from Blockscout's UI to this app (`explorer/web`). **Nothing here has been run
against production yet.** The spec is `.ui-craft/surfaces/explorer.md` §13.

## What changes, and what doesn't

| | Before | After |
|---|---|---|
| `https://explorer.ferminux.net/` and every page | `fmx-explorer-frontend` (Blockscout UI, Next.js) | static files from `explorer/web/dist`, served by `fmx-explorer-proxy` |
| `/api`, `/api?module=…` (Etherscan-style), `/api/v2/*`, `/api/v1/graphql`, `/api/eth-rpc`, `/socket/*` | `fmx-explorer-backend` | **unchanged**: `fmx-explorer-backend` |
| `fmx-explorer-backend`, `-db`, `-rewards` (the index) | running | **unchanged**, still the data source |
| `fmx-explorer-frontend` | running | **stopped, not removed**, kept for rollback |
| Edge nginx (`infra/compose/nginx/nginx.conf`, TLS + rate limits) | proxies the host to `fmx-explorer-proxy:80` | **unchanged** |

Where things live on the server (the netcup box that runs the explorer stack):

- The stack: `/opt/ferminux/explorer` (compose project; `docker-compose.yml` + `docker-compose.prodnet.yml`, `.env`).
- The proxy config today: `/opt/ferminux/explorer/proxy/default.conf`, a single-file bind mount. It is not
  edited: rollback uses it.
- New: `/opt/ferminux/explorer/web/dist/` (the static build), `/opt/ferminux/explorer/proxy/spa/` (the new
  nginx config, mounted as a directory), `/opt/ferminux/explorer/docker-compose.spa.yml` (the overlay).

The files that go to the server are all in this folder:

```
explorer/web/
├── dist/                          # npm run build (the static site)
└── deploy/
    ├── proxy/default.conf         # → /opt/ferminux/explorer/proxy/spa/default.conf
    ├── proxy/security-headers.inc # → /opt/ferminux/explorer/proxy/spa/security-headers.inc
    ├── docker-compose.spa.yml     # → /opt/ferminux/explorer/docker-compose.spa.yml
    └── smoke.sh                   # run from anywhere after the switch
```

### The new proxy config (`deploy/proxy/default.conf`)

- **Index backend.** The location is `~ ^/(api(/|$)|socket(/|$)|public-metrics(/|$)|auth/)` and goes to
  `backend:4000` with the same headers and timeouts as before. It covers `/api` itself, so
  `/api?module=block&action=eth_block_number` still works. The old regex matched the bare prefix `api` and
  would have sent our `/api-docs` page to the backend; the new one is anchored. `sitemap.xml` now comes from
  our static build.
- **The SPA.** `map $uri $spa_route` lists the app's routes (§3.4). A known route gets `index.html` with a
  200. Any other path gets `404.html` (the same shell) **with a 404 status**, and the app draws its own 404
  page. So `/csv-export` returns a real 404.
- **The validators pages** (`/validators`, `/validators/:id`, Step 1 checkpoint validators) are map value 2:
  nginx serves them from `validators.html`, a byte copy of `index.html` that `vite build` writes only when
  `validatorHub` and `validatorHubLens` are set in `src/data/contracts.3961.json` (or `VITE_VALIDATOR_HUB` and
  `VITE_VALIDATOR_HUB_LENS` at build time). Until then the file is absent and they are real 404s, the nav link
  stays hidden and the sitemap leaves them out. Switching them on is a rebuild with the addresses in the book;
  the proxy config does not change. Seat IDs are digits only; anything else is a 404.
- **Legacy Blockscout URLs** (§3.6) get a 307 before the SPA, with a relative `Location`: `/blocks/:n`,
  `/tx/:h/logs`, `/address/:a/transactions`, `/tokens/:a`, `/token/:a/token-holders`, `/uncles`,
  `/graphiql` and the rest. `/charts` gets a 308. The client router has the same map for in-app hits.
- **Cache headers.**

  | Path | Cache-Control |
  |---|---|
  | `/assets/*` (hashed build output) | `public, max-age=31536000, immutable` (200 responses only, so a missing asset's 404 is never cached) |
  | `/fonts/*` | `public, max-age=2592000` |
  | `/brand/*` | `public, max-age=86400` |
  | `/favicon.svg`, `/robots.txt`, `/sitemap.xml`, `/llms.txt` | `public, max-age=3600` |
  | the app shell (every page, `/index.html`, the 404) | `no-cache`, so a deploy shows up on the next page load |
  | `/api*` | unchanged (whatever the index sends) |

- **Security headers** on every static response (`security-headers.inc`):
  - a strict CSP: `script-src 'self'` plus the hash of the one inline head script;
    `connect-src 'self' https://rpc.ferminux.net https://ferminux.net`;
    `img-src 'self' data: https://ferminux.net`; `frame-ancestors 'none'`;
  - `nosniff`, `Referrer-Policy` and `Permissions-Policy`.
- gzip for text types. The edge still does TLS and rate limiting.

### Tested locally

The config was run in `nginx:1.29-alpine`, the same image as `fmx-explorer-proxy`, with `/api*` going to the
live index. Results:

- `nginx -t` passes.
- `smoke.sh` gave the expected status, content type, cache header and CSP for every row. The
  Etherscan-style `/api?module=…` and `/api/eth-rpc` both answer `eth_blockNumber`.
- Seven page types were loaded in Chromium under this exact CSP. There were no violations, and the hashed
  inline script ran.

## 0. Build (on your machine)

```sh
cd explorer/web
npm ci
npm run build          # tsc --noEmit, public/sitemap.xml, vite build → dist/ (and dist/404.html)
npm run test:signer    # the Clique signer recovery tests (25/25)
# optional, only if the index recorded new forked blocks (canon.ts also reads them at runtime):
# npm run noncanonical && npm run build
```

**CSP hash.** The CSP in `deploy/proxy/security-headers.inc` must hash the inline `<script>` in
`dist/index.html`. It is `sha256-UZZ2Y784oy0r0hDtbbp69jCVh3RgpsGGDCL8Yjm/Pdc=` today. Check it after every
build that touches `index.html`:

```sh
python3 -c "import re,hashlib,base64;s=open('dist/index.html').read();b=re.search(r'<script>(.*?)</script>',s,re.S).group(1);print('sha256-'+base64.b64encode(hashlib.sha256(b.encode()).digest()).decode())"
grep -o "sha256-[^']*" deploy/proxy/security-headers.inc
```

If the two differ, put the new hash in `security-headers.inc`. Otherwise the browser blocks the motion-tier
script and nothing tells you.

## 1. Upload (nothing live changes yet)

Set `FMX_HOST` to the SSH target of the explorer server, for example `root@<explorer host>`.

```sh
cd explorer/web
ssh "$FMX_HOST" 'mkdir -p /opt/ferminux/explorer/web/dist /opt/ferminux/explorer/proxy/spa'
# the hashed assets first, never deleted (an open tab may still lazy-load an older chunk)…
rsync -a dist/assets/ "$FMX_HOST":/opt/ferminux/explorer/web/dist/assets/
# …then the shell and the static files
rsync -a --delete-after --exclude assets/ dist/ "$FMX_HOST":/opt/ferminux/explorer/web/dist/
rsync -a deploy/proxy/ "$FMX_HOST":/opt/ferminux/explorer/proxy/spa/
scp deploy/docker-compose.spa.yml "$FMX_HOST":/opt/ferminux/explorer/docker-compose.spa.yml
```

## 2. Pre-flight on the server (still nothing live changes)

```sh
cd /opt/ferminux/explorer
cp .env .env.bak-spa-$(date +%Y%m%d)
# the new config, checked in a throwaway container with the real mounts
docker run --rm -v "$PWD/proxy/spa:/etc/nginx/conf.d:ro" -v "$PWD/web/dist:/usr/share/nginx/explorer:ro" nginx:1.29-alpine nginx -t
# the merged stack: expect  backend db proxy rewards-sidecar   (no frontend)
docker compose -f docker-compose.yml -f docker-compose.prodnet.yml -f docker-compose.spa.yml config --services
```

The overlay needs Compose ≥ 2.24 for its `!override` tags. The server runs v5.5.0.

## 3. The switch

```sh
cd /opt/ferminux/explorer
# make the overlay part of every later `docker compose` command in this directory
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.prodnet.yml:docker-compose.spa.yml' >> .env
# recreate ONLY the proxy with the new mounts (--no-deps: don't touch backend/db/frontend)
docker compose up -d --no-deps --force-recreate proxy
# Blockscout's UI: stop it and keep it
docker stop fmx-explorer-frontend
```

- The edge nginx resolves `fmx-explorer-proxy` on every request, so recreating the proxy costs about one
  second of 502s. The edge is not restarted.
- `docker compose up -d` no longer starts `fmx-explorer-frontend`, because the overlay puts it behind the
  `blockscout-ui` profile. The container stays on the server, stopped, for rollback. Don't
  `docker compose down` or `rm` it until the new site has run for a week (see Follow-ups).
- **Cloudflare** (the host is orange-clouded). HTML and `/api` aren't cached at the edge, and the new
  `/assets/*` names are hashed. Purge only `https://explorer.ferminux.net/favicon.svg`: SVG is on
  Cloudflare's default cached list, and the URL is the same as Blockscout's.

## 4. Verify

From any machine:

```sh
sh explorer/web/deploy/smoke.sh https://explorer.ferminux.net
```

Expected:

- **App routes return 200** `text/html`, `cache=no-cache`, `csp=1`. This covers `/`, `/blocks`,
  `/block/:n`, `/block/0x…`, `/block/countdown/:n`, `/txs`, `/tx/:h`, `/address/:a?tab=…`, `/tokens`,
  `/token/:a`, `/token/:a/instance/:id`, `/accounts`, `/verified-contracts`, `/stats`,
  `/search-results?q=`, `/api-docs` and `/index.html`.
- **Unknown paths return 404** `text/html`: `/this-page-does-not-exist`, and `/validators` while the
  build has no ValidatorHub address (200 once it does).
- **The index still answers.** `/api/v2/stats`, `/api/v2/main-page/blocks` and
  `/api?module=block&action=eth_block_number` return 200 `application/json`. `etherscan-style:` and
  `eth-rpc proxy:` print `{"jsonrpc":"2.0","result":"0x…"}`.
- **Legacy URLs redirect.** `/blocks/396000` → 307 `/block/396000`. `/tx/…/logs` → 307 `/tx/…?tab=logs`.
  `/address/…/transactions` → 307 `/address/…`. `/tokens/…` → 307 `/token/…`. `/charts` → 308 `/stats`.
- **Static files.** `/assets/index-*.js` is `immutable`. `/assets/nope.js` is a 404 with no cache header.
  `/fonts/*` is `max-age=2592000`.
- **`no Blockscout: 0 mentions in /`.**

In a browser, on a phone and on a desktop:

- The home page: the head block number ticks every 7 s, and a new block slides into Latest blocks.
- `/block/<head>`: the signer seal, and "Around this block" filling in as new blocks land.
- `/tx/<any>`: the story sentence and the decoded input.
- `/address/0xF61d31FeC999af448C06fFaBB5EC28FbEE482847?tab=coin_balance_history`: Transactions reads 30 and
  the balance chart is drawn.
- `/token/0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd/instance/41`: the NFT image loads from ferminux.net.
- The browser console shows no CSP errors.
- The index's own API is still browsable: `https://explorer.ferminux.net/api/v2/blocks`.

On the server:

```sh
docker ps --format '{{.Names}} {{.Status}}' | grep explorer   # proxy/backend/db/rewards Up; frontend Exited
docker logs --since 10m fmx-explorer-proxy 2>&1 | grep -v ' 200 \| 304 \| 307 ' | tail -20
```

## Rollback (about a minute)

```sh
cd /opt/ferminux/explorer
sed -i '/^COMPOSE_FILE=/d' .env                      # or: cp .env.bak-spa-YYYYMMDD .env
docker compose -f docker-compose.yml -f docker-compose.prodnet.yml up -d --force-recreate proxy frontend
```

This brings back the old `proxy/default.conf` (never edited) and starts the kept `fmx-explorer-frontend`.
The index was never touched, so no data can be lost either way.

## Later updates

- **A new build.** Run steps 0 and 1 again. The server needs no restart: `web/dist` is a directory mount and
  the shell is `no-cache`. Old hashed assets stay in `dist/assets/`; clear out anything older than a month
  now and then.
- **A proxy config edit.** Upload it to `proxy/spa/`, then run
  `docker exec fmx-explorer-proxy nginx -t && docker exec fmx-explorer-proxy nginx -s reload`. The config is a
  directory mount, so an rsync rename doesn't leave the container on a stale file, unlike the old
  single-file `default.conf` mount.

## Follow-ups (not part of the switch)

- After a week without a rollback, run `docker rm fmx-explorer-frontend` and
  `docker image rm ghcr.io/blockscout/frontend:v2.3.5` (about 220 MB). Then drop the `frontend` service and
  its `NEXT_PUBLIC_*` branding from `docker-compose.yml`, `envs/frontend.env` and `k8s/40-frontend.yaml` /
  `k8s/15-configmaps.yaml` (§13.6).
- Fold `deploy/proxy/default.conf` into `explorer/proxy/` and `k8s/60-ingress.yaml`, so the repo describes
  what production runs.
- Fix `infra/listings/eip155-3961.json` `"icon"`, and the `explorer.ferminux.network` URL in
  `miner-app/lib/src/services/rpc_client.dart:14` (§13.6).
