# Ferminux Explorer — Blockscout

Blockscout block explorer for **Ferminux Network** (ChainID **3961**, coin **FMX**,
Ethash PoW, ~7s blocks, EIP-1559 from genesis, 6 FMX reward halving every
4,500,000 blocks).

Every image tag is pinned and was verified **multi-arch (linux/amd64 + linux/arm64)**
with `docker manifest inspect` on 2026-08-20 — these are the newest release tags
Blockscout actually publishes as images (GitHub cuts newer source releases, but
`ghcr.io` image publishing stops at these):

| Service  | Image                                | Platforms            |
|----------|--------------------------------------|----------------------|
| backend  | `ghcr.io/blockscout/blockscout:9.0.2`| amd64, arm64         |
| frontend | `ghcr.io/blockscout/frontend:v2.3.5` | amd64, arm64         |
| db       | `postgres:17.5-alpine`               | amd64, arm64, others |
| proxy    | `nginx:1.29-alpine`                  | amd64, arm64, others |

All external integrations are disabled (exchange rates, ads, Sourcify, verifier /
sig-provider / metadata microservices, analytics). The stack talks only to the
configured Ferminux node and its own Postgres. Fully self-hosted.

## Layout

```
explorer/
├── docker-compose.yml       # full stack: db + backend + rewards-sidecar + frontend + nginx proxy
├── .env.example             # every overridable knob (local defaults are baked in)
├── envs/backend.env         # static Blockscout backend config (chain id, coin, fetcher flags)
├── envs/frontend.env        # static frontend config (network name, FMX, decimals)
├── proxy/default.conf       # nginx: /api,/socket -> backend:4000, rest -> frontend:3000
├── chainspec/genesis.json   # copy of the chain genesis; imports premine balances
├── seeder/                  # miner-reward seeder (see "Why a rewards sidecar")
└── k8s/                     # same stack for Kubernetes (namespace ferminux)
```

## Why a rewards sidecar

`ferminux-geth` is a geth v1.10.26 fork. Blockscout's `geth` JSON-RPC variant
cannot fetch PoW block beneficiaries over RPC (that needs `trace_block`, a
Nethermind/Erigon API), so out of the box the explorer would show **no miner
rewards**. The `rewards-sidecar` (compose) / `explorer-rewards-seeder` CronJob
(k8s) writes the exact consensus reward into Blockscout's own `block_rewards`
table:

```
reward = subsidy + tip fees
subsidy = 6 FMX >> era,  era = block / 4,500,000   (chain/consensus/ethash/ferminux.go)
tip fees = sum(tx gas_used × effective_gas_price) − base_fee × block gas_used
```

It also seeds the static `emission_rewards` halving schedule. It writes only to
the explorer's Postgres — never to the chain. Uncle rewards are not modeled
(uncles are effectively absent at 7s blocks).

Caveat: the *first page* of `GET /api/v2/blocks` is served from Blockscout's
in-memory block cache, which is populated at index time — seconds before the
seeder runs — so brand-new blocks can briefly show `"rewards": []` there. Any
paged request (`?block_number=N`), the single-block endpoint, and the block page
in the UI show the correct reward.

## Local smoke test (against the live devnet)

Requires the devnet running (`fmx-rpc` publishing `localhost:8545/8546`).
Ports used: **4000** (explorer UI + API) and **7432** (postgres, debug only).

```sh
cd <repo>/explorer
docker compose config --quiet          # validate
docker compose up -d                   # first start pulls ~1.5 GB of images

# backend compiles config + runs migrations; API is up in ~60–90s:
curl -s http://localhost:4000/api/v2/blocks | head -c 400
curl -s http://localhost:4000/api/v2/blocks/650          # single block, shows 6 FMX Miner Reward
curl -s "http://localhost:4000/api/v2/blocks?block_number=700&items_count=5"
curl -s http://localhost:4000/api/v2/main-page/indexing-status
open http://localhost:4000/                              # frontend

docker compose down -v                 # tear down, delete volumes
```

Verified on this Mac (colima aarch64, 4 CPU / 8 GiB) on 2026-08-20:
blocks indexed live to the chain head, `indexed_blocks_ratio: 1.00`,
`/api/v2/blocks/650` returned `{"reward": "6000000000000000000", "type": "Miner Reward"}`,
premine balances imported at block 0 from `chainspec/genesis.json`,
total stack memory ≈ 750 MB.

Devnet-only log noise: the devnet node prunes historical state, so the
coin-balance fetcher logs `missing trie node` for old heights. Harmless —
balances resolve at recent heights. In production, point the explorer at an
**archive node** (`--gcmode archive`) to avoid it entirely.

## Pointing it at a node

The node URL is parameterized; defaults hit the local devnet through
`host.docker.internal` (works under colima and Docker Desktop — the compose file
adds the `host-gateway` mapping explicitly):

```sh
FMX_RPC_HTTP=http://host.docker.internal:8545   # default
FMX_RPC_WS=ws://host.docker.internal:8546       # default
```

Override in `.env` (see `.env.example`). Production values are typically the
internal RPC service or `https://rpc.ferminux.net` / `wss://rpc.ferminux.net`.
The node must expose `eth`, `net`, `web3` (and ideally `txpool`) over HTTP and WS.
`debug`/`trace` are NOT required — internal-transaction indexing is disabled to
match ferminux-geth's public RPC surface.

## Production — single server (compose)

```sh
cd explorer
cp .env.example .env
# set in .env:
#   FMX_RPC_HTTP / FMX_RPC_WS         -> your node
#   FMX_EXPLORER_HOST=explorer.ferminux.net
#   FMX_EXPLORER_PUBLIC_PORT=443
#   FMX_EXPLORER_PROTO=https
#   FMX_EXPLORER_WS_PROTO=wss
#   FMX_PUBLIC_RPC_URL=https://rpc.ferminux.net
#   POSTGRES_PASSWORD=$(openssl rand -hex 24)
#   SECRET_KEY_BASE=$(openssl rand -base64 48)
docker compose up -d
```

Then terminate TLS in front of port 4000 (Cloudflare -> origin nginx/caddy with
a Cloudflare Origin CA cert, `proxy_pass http://127.0.0.1:4000` with websocket
upgrade headers for `/socket`). Do not expose 7432 publicly.

## Production — Kubernetes

Manifests in `k8s/` (namespace `ferminux`), validated with kubeconform
(`14 resources, Valid: 14, Invalid: 0` on 2026-08-20):

```sh
# validate
docker run --rm -v "$PWD/k8s:/manifests:ro" ghcr.io/yannh/kubeconform:latest -strict -summary /manifests

# secrets first — replace the placeholders (or edit 10-secrets.yaml):
kubectl -n ferminux create secret generic explorer-secrets \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 24)" \
  --from-literal=SECRET_KEY_BASE="$(openssl rand -base64 48)" \
  --from-literal=DATABASE_URL="postgresql://blockscout:<same password>@explorer-db:5432/blockscout"

kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/            # applies everything else in order
```

- RPC endpoint: edit `ETHEREUM_JSONRPC_*_URL` in `k8s/15-configmaps.yaml`
  (defaults to `fmx-rpc.ferminux.svc.cluster.local:8545/8546`).
- Ingress host `explorer.ferminux.net`: routes `/api`, `/socket`, `/auth`,
  `/sitemap.xml`, `/public-metrics` to the backend, everything else to the
  frontend. TLS uses secret `explorer-origin-tls` — a **Cloudflare Origin CA**
  certificate (Cloudflare dashboard -> SSL/TLS -> Origin Server), zone mode
  "Full (strict)", orange-clouded DNS record; restrict origin ingress to
  Cloudflare IP ranges. Details in `k8s/60-ingress.yaml`.
- The backend runs `replicas: 1` with `strategy: Recreate` — never run two
  indexers against one database.

## Resource requirements

| Component | Idle/devnet | Recommended production        |
|-----------|-------------|-------------------------------|
| backend   | ~350 MB     | 1–4 GB RAM, 0.5–2 CPU         |
| postgres  | ~170 MB     | 2 GB RAM, 50 GB+ disk (grows with chain history) |
| frontend  | ~220 MB     | 256 MB–1 GB RAM               |
| proxy     | ~5 MB       | negligible                    |
| seeder    | ~1 MB       | negligible                    |

Whole stack fits in ~1 GB RAM on an empty chain; budget 4–8 GB RAM and fast SSD
for a chain with real traffic. The node the explorer indexes from should be an
archive node for complete historical balances.

## Env reference

| Variable | Default | Meaning |
|---|---|---|
| `FMX_RPC_HTTP` | `http://host.docker.internal:8545` | JSON-RPC HTTP URL (from inside containers) |
| `FMX_RPC_WS` | `ws://host.docker.internal:8546` | JSON-RPC WebSocket URL (realtime blocks) |
| `FMX_EXPLORER_PORT` | `4000` | Host port of the nginx entrypoint |
| `FMX_EXPLORER_DB_PORT` | `7432` | Host port of postgres (debug; firewall in prod) |
| `FMX_EXPLORER_HOST` | `localhost` | Public hostname the browser uses |
| `FMX_EXPLORER_PUBLIC_PORT` | `4000` | Public port (443 behind TLS) |
| `FMX_EXPLORER_PROTO` | `http` | `http` or `https` |
| `FMX_EXPLORER_WS_PROTO` | `ws` | `ws` or `wss` |
| `FMX_PUBLIC_RPC_URL` | `https://rpc.ferminux.net` | RPC URL the frontend offers for "add network to wallet" |
| `POSTGRES_PASSWORD` | dev default | **Override in production** |
| `SECRET_KEY_BASE` | dev default | Phoenix secret — **override in production** |

Static chain config (chain id 3961, FMX, fetcher flags) lives in
`envs/backend.env` / `envs/frontend.env` and `k8s/15-configmaps.yaml`.

## Known limitations

- **Internal transactions are not indexed** — ferminux-geth's public RPC exposes
  no `debug`/`trace` namespace. If a traced node becomes available, remove
  `INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER` and point
  `ETHEREUM_JSONRPC_TRACE_URL` at it.
- **Contract verification microservice is off** (`smart-contract-verifier` is a
  separate service; add it later if verified-source UX is needed).
- **No stats/charts microservice** — homepage charts are disabled
  (`NEXT_PUBLIC_HOMEPAGE_CHARTS=[]`).
- The frontend API-docs page (`/api-docs`) fetches its swagger definition from
  GitHub client-side if opened; core explorer pages are fully self-contained.
- First page of `/api/v2/blocks` can transiently show `"rewards": []` for
  seconds-old blocks (in-memory cache races the reward seeder; see above).
