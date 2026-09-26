# Ferminux Network — public site

Static landing/download page for **ferminux.net**. Vanilla HTML/CSS/JS,
fully self-contained: system font stack, no CDNs, no analytics, zero external
requests. The only network call the page ever makes is JSON-RPC to the chain
itself (live stats strip).

```
site/
├── index.html         # single page: hero, live telemetry band, markets (DEX + AZNT),
│                      # quickstart, downloads, wallet, chain params, ecosystem directory
├── assets/
│   ├── style.css      # institutional dark theme; shared rail grid, amber accent,
│   │                  # tabular numerals, hairline borders
│   └── app.js         # telemetry band + block tape, DEX price, Add-to-MetaMask,
│                      # tabs, copy buttons (pure logic exported for Node tests)
├── test/
│   └── stats.test.cjs # unit + live-RPC tests for the app.js logic (Node)
└── README.md
```

## Features

- **Live telemetry band** — batched JSON-RPC (`eth_blockNumber`,
  `eth_getBlockByNumber latest`, `eth_chainId`, plus `eth_call
  getReserves()` on the FMX/AZNT pair) polled every 7 s. Renders block
  height (pulses on new blocks), base fee, gas limit, chain ID, the live
  FMX price in AZNT from the DEX pair reserves, the authorised signer count
  (`clique_getSigners`, refreshed every 5 minutes) and average block time over the last ~18 headers. RPC endpoint resolution: `?rpc=<url>` query override →
  `data-rpc` attribute on `<body>` → `https://rpc.ferminux.net`.
  Unreachable RPC degrades to a red dot + "unreachable"; last-known values
  stay on screen. A chain-ID mismatch renders in the warning color.
- **Block tape** — an inline SVG of the most recent blocks drawn from the
  same header fetches: link length ∝ seconds between blocks, newest block
  highlighted and animated on arrival (honors `prefers-reduced-motion`).
  On a local devnet without the DEX pair deployed, the price shows "—" and
  everything else works.
- **Markets section** — live FMX/AZNT price from the pair contract
  (`0xbab12e7B817F0686e11949eC06697235DC146845`, token0 = wrapped FMX,
  token1 = AZNT — ordering fixed at pair creation), plus the AZNT
  stablecoin facts (600,000 supply, 6 decimals,
  `0xFc81ad7c145B868ef0CEC8D7Ec881Ac93f724178`).
- **Add to MetaMask** — one tap calls `wallet_addEthereumChain` with the exact
  params from `../wallet/metamask-add-network.json` (chainId `0xF79`, RPC
  `https://rpc.ferminux.net`, explorer `https://explorer.ferminux.net`).
  No wallet installed → status message + the manual-parameters table (always
  visible) covers the fallback.
- **Quickstart** — run a node (install, sync, local JSON-RPC), with copy
  buttons. The tab component keeps its keyboard (arrow-key) navigation.

## Local preview

```bash
cd site
python3 -m http.server 8090
# open http://localhost:8090/?rpc=http://localhost:8545   ← stats from a local devnet
# open http://localhost:8090/                              ← stats from production RPC
```

The `?rpc=` override accepts `http(s)` URLs only (anything else is ignored)
and exists exactly for previewing against a local node without editing files.
For a permanent non-production default, change `data-rpc="…"` on `<body>`.

## Deploy to nginx

Copy the directory and serve it as plain static files — there is no build step:

```bash
rsync -av --delete site/ user@host:/var/www/ferminux.net/
```

```nginx
server {
    listen 443 ssl http2;
    server_name ferminux.net www.ferminux.net;

    # ssl_certificate / ssl_certificate_key ...

    root /var/www/ferminux.net;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    # cache static assets; HTML stays fresh
    location /assets/ {
        add_header Cache-Control "public, max-age=86400";
    }
    location = /index.html {
        add_header Cache-Control "no-cache";
    }
}

server {
    listen 80;
    server_name ferminux.net www.ferminux.net;
    return 301 https://ferminux.net$request_uri;
}
```

`https://rpc.ferminux.net` must send CORS headers
(`Access-Control-Allow-Origin: https://ferminux.net` or `*`, plus
`Content-Type` in allowed headers for the JSON-RPC POST preflight) or the
stats strip will show "unreachable" even when the chain is healthy. For the
`ferminux` node that is `--http.corsdomain "https://ferminux.net"` on the RPC node (or the
equivalent header injection in the nginx proxy in front of it).

## Downloads

Download links point at `/downloads/<asset>` on this host (plus
`/downloads/SHA256SUMS.txt`), so the binaries are served next to the site:

| Asset | Platform |
|---|---|
| `ferminux-geth-linux-amd64.tar.gz` | Linux amd64 |
| `ferminux-geth-linux-arm64.tar.gz` | Linux arm64 |
| `ferminux-geth-macos-arm64.tar.gz` | macOS arm64 (Apple Silicon) |

The page does not link a Windows build; it says a tested Windows build is
coming soon. The `ferminux-geth-windows-amd64.zip` that was on the download
host was the pre-fork package (it stops at block 159,999). It is withdrawn from
`/downloads/` and from `SHA256SUMS.txt`, and nginx answers its old URL with
410 Gone and this advice. A Windows row comes back only when a Windows build
has been run on Windows and followed the chain past block 160,000.

Asset names must match what `/chain`'s release workflow
(`.github/workflows/release.yml`) publishes — adjust either side if they
drift. Docs/launchpad links point at
`docs.ferminux.net` and `launchpad.ferminux.net` — confirm those
subdomains when the components deploy.

## Tests that were run (2026-08-20, this Mac — post-redesign)

- `node test/stats.test.cjs` — 40/40 assertions on the **actual**
  `assets/app.js` module: `?rpc=` override precedence + non-http rejection,
  stats/blocks batch request building, response parsing (incl. gas limit
  and pair reserves), DEX price math from `getReserves` words, tape vitals
  (avg interval + hashrate estimate), all formatters, the offline rejection
  path, and live fetches through the identical `fetchStats`/`fetchBlocks`
  code paths. The live section prefers the devnet on :8545 and falls back
  to the production RPC (returned height 14,493, chainId 3961, base fee
  7 wei, gas limit 100M, price 0.3244 AZNT).
- Served with `python3 -m http.server 8670`; headless Chromium end-to-end
  render at 1440 / 1024 / 390 px: telemetry band showed live height,
  `7 wei`, price `0.3244`, hashrate, avg block time, `100M`, `3961`; the
  block tape rendered real headers with interval labels; zero horizontal
  overflow at every width (`scrollWidth == clientWidth`).
- Offline render (`?rpc=http://localhost:59999`): red dot + "unreachable",
  em-dash values, "waiting for blocks…" caption — no errors.
- Request audit at all three widths: the page issued requests only to
  `localhost:8670` (its own assets) and `https://rpc.ferminux.net` — no
  external asset/script/font/analytics requests of any kind.
