# Ferminux Explorer — Blockscout

Blockscout block explorer for **Ferminux Network** (ChainID **3961**, coin **FMX**,
Clique proof-of-authority with five bonded signers, ~7 s blocks, EIP-1559 from
genesis).

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
| smart-contract-verifier | `ghcr.io/blockscout/smart-contract-verifier:v1.10.7` | amd64, arm64 (run as amd64, see [Contract verification](#contract-verification)) |

External integrations are disabled (exchange rates, ads, Sourcify, eth-bytecode-db,
sig-provider / metadata microservices, analytics). The stack talks to the configured
Ferminux node and its own Postgres. The one outbound exception is the contract
verifier, which downloads compilers on first use.

## Layout

```
explorer/
├── docker-compose.yml       # full stack: db + backend + rewards-sidecar + smart-contract-verifier
│                            #             + frontend + nginx proxy
├── .env.example             # every overridable knob (local defaults are baked in)
├── envs/backend.env         # static Blockscout backend config (chain id, coin, fetcher flags)
├── envs/verifier.env        # static smart-contract-verifier config
├── envs/frontend.env        # static frontend config (network name, FMX, decimals)
├── scripts/verify-contracts.sh  # verifies our own contracts through the explorer
├── proxy/default.conf       # nginx: /api,/socket -> backend:4000, rest -> frontend:3000
├── chainspec/genesis.json   # copy of the chain genesis; imports premine balances
├── seeder/                  # block-reward seeder (see "Why a rewards sidecar")
└── k8s/                     # same stack for Kubernetes (namespace ferminux)
```

## Why a rewards sidecar

The `ferminux` node client (v1.10.26 lineage) is served through Blockscout's
`geth` JSON-RPC variant, which cannot fetch block rewards over RPC (that needs
`trace_block`, a Nethermind/Erigon API), so out of the box the explorer would
show **no block rewards**. The `rewards-sidecar` (compose) /
`explorer-rewards-seeder` CronJob (k8s) writes the exact consensus reward into
Blockscout's own `block_rewards` table (`seeder/seed-rewards.sql` mirrors the
chain):

```
reward   = subsidy share + tip fees
subsidy  = 6 FMX below block 20,000; from it 1 FMX >> era, era = block / 4,500,000
           (chain/consensus/powhash/ferminux.go)
from block 160,000 (chain/consensus/posa): subsidy / 4, split 40% signer,
           50% reward sink, 10% treasury
tip fees = sum(tx gas_used × effective_gas_price) − base_fee × block gas_used
```

It also seeds the static `emission_rewards` halving schedule. It writes only to
the explorer's Postgres — never to the chain. Uncle rewards are not modeled
(uncles are effectively absent at 7s blocks, and authority blocks have none).

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
match the `ferminux` node's public RPC surface.

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
| verifier  | ~80 MB idle, ~300 MB compiling | capped at 1 GB RAM, 1 CPU; ~15 MB disk per solc version |

Whole stack fits in ~1 GB RAM on an empty chain; budget 4–8 GB RAM and fast SSD
for a chain with real traffic. The node the explorer indexes from should be an
archive node for complete historical balances.

## Contract verification

Source verification is Blockscout's `smart-contract-verifier` service
(`smart-contract-verifier` in `docker-compose.yml`, container `fmx-explorer-verifier`).
Without it the backend has no compiler list at all:
`/api/v2/smart-contracts/verification/config` returns an empty
`solidity_compiler_versions`, and nothing can be verified.

How it is wired:

- **Version.** `v1.10.7`, the newest release of the 1.10 line, which was the current
  verifier when Blockscout 9.0.2 shipped (verifier 1.10.0 in May 2025, Blockscout 9.0.2 in
  August 2025). The backend only calls the verifier's `/api/v2/verifier/solidity/…` and
  `/api/v2/verifier/vyper/…` routes, which are unchanged across 1.10.x.
- **Backend** (`envs/backend.env`): `MICROSERVICE_SC_VERIFIER_ENABLED=true`,
  `MICROSERVICE_SC_VERIFIER_URL=http://smart-contract-verifier:8050/`,
  `MICROSERVICE_SC_VERIFIER_TYPE=sc_verifier`. The URL must be set: unset, Blockscout falls
  back to its own hosted eth-bytecode-db.
- **Network.** No published port. The verifier is on the project's default network only,
  so the backend reaches it by service name and nothing outside the stack can. The
  `prodnet` overlay does not add it to `fmxnet`.
- **Platform.** Pinned to `linux/amd64`, as in Blockscout's own compose: solc is published
  only as a linux-amd64 binary, which the arm64 image cannot run. The server is x86_64.
  On an Apple-silicon Mac it runs under emulation (colima runs it; compiles are slower).
- **Compilers** download on first use from `binaries.soliditylang.org` (Vyper: GitHub) and
  stay in the `verifier-compilers` volume, mounted at `/tmp` because the image runs as uid
  1001 and `/tmp` is the one directory it may write; a volume at a path the image lacks
  would be root-owned. Sourcify is off (it does not index chain 3961).
- **Limits.** `mem_limit 1g`, `cpus 1.0`, `pids_limit 256`, one compile at a time
  (`SMART_CONTRACT_VERIFIER__COMPILERS__MAX_THREADS=1`), the shared 50 MB × 5 log cap,
  `restart: unless-stopped`, and a `/health` healthcheck. The backend does not depend on
  it: if the verifier is down, the explorer keeps running and only verification stops.

### Tested locally (2026-09-25)

The verifier (`v1.10.7`, linux/amd64 under colima) was sent each contract below the way
Blockscout 9.0.2 sends it: forge's standard-JSON input, `compilerVersion
v0.8.24+commit.e11b9ed9`, and the real on-chain creation input read from
rpc.ferminux.net. For the two contracts another contract created (no creation
transaction in the index, because internal transactions are not indexed) Blockscout sends
the deployed code instead, and so did the test. All 28 matched:

- **Full match (16):** FerminuxCitizens (creation tx `0xd04c03f2…6df62f`, block 404,087,
  704 bytes of constructor arguments, which the verifier extracted itself), AgentRegistry,
  ServiceEscrow, X402Vault, AgentAccountFactory, AgentAccount (deployed code), StreamPay,
  ArbiterPool, MinimalMultisig, AZNT, USDF, TokenFactory, Faucet, FMXVesting,
  FMXRewardSink, FoundationLock.
- **Partial match (12):** the code is identical; only the metadata hash differs or is absent.
  FerminuxAgents, the three agent registries and AgentTokenFactory were deployed before
  the 2026-09-24 vocabulary pass, which changed only their comments; verifying the current
  source keeps the published comments in our own vocabulary. FerminuxBridge (both
  deployments) has comment-only changes since its deploy. WFMX, FerminuxFactory,
  FerminuxRouter, LiquidityLocker and FerminuxPair are built without metadata
  (`dex/contracts/foundry.toml`: `cbor_metadata = false`), so there is no hash to match
  fully.

Peak verifier memory over the whole run was about 300 MB; the largest input (the
bridge, built via IR) compiled in about 24 s under emulation.

End to end, a local Blockscout 9.0.2 backend with this `envs/backend.env` (API only, three
blocks indexed) reported `is_rust_verifier_microservice_enabled: true` and 95 Solidity
versions including `v0.8.24+commit.e11b9ed9`. The exact requests `forge verify-contract
--verifier blockscout` (forge 1.7.1) sends were then posted to its `/api`:
FerminuxCitizens came back `Pass - Verified` as a full match with its constructor
arguments decoded, FerminuxAgents as a partial match, and AgentAccount (deployed code, no
creation transaction) as a full match.

### Deploy (production, `/opt/ferminux/explorer`)

The server runs with
`COMPOSE_FILE=docker-compose.yml:docker-compose.prodnet.yml:docker-compose.spa.yml` in its
`.env`, so plain `docker compose` commands there use all three files. Only
`docker-compose.yml`, `envs/backend.env` and the new `envs/verifier.env` change.

From a checkout of this repo (`FMX_HOST` = SSH target of the explorer server):

```sh
# the server copies must be the ones this change was made against: no output means no drift
git show c25fddb^:explorer/docker-compose.yml | ssh "$FMX_HOST" 'diff - /opt/ferminux/explorer/docker-compose.yml'
git show c25fddb^:explorer/envs/backend.env  | ssh "$FMX_HOST" 'diff - /opt/ferminux/explorer/envs/backend.env'

ssh "$FMX_HOST" 'cd /opt/ferminux/explorer && d=$(date +%Y%m%d) &&
  cp docker-compose.yml docker-compose.yml.bak-verifier-$d && cp envs/backend.env envs/backend.env.bak-verifier-$d'
scp explorer/docker-compose.yml "$FMX_HOST":/opt/ferminux/explorer/docker-compose.yml
scp explorer/envs/backend.env explorer/envs/verifier.env "$FMX_HOST":/opt/ferminux/explorer/envs/
```

On the server:

```sh
cd /opt/ferminux/explorer
grep '^COMPOSE_FILE=' .env           # docker-compose.yml:docker-compose.prodnet.yml:docker-compose.spa.yml
docker compose config --services     # backend db proxy rewards-sidecar smart-contract-verifier

# 1. the verifier on its own; nothing else restarts
docker compose pull smart-contract-verifier
docker compose up -d --no-deps smart-contract-verifier
docker inspect -f '{{.State.Health.Status}}' fmx-explorer-verifier     # healthy after ~20 s
docker exec fmx-explorer-backend curl -s http://smart-contract-verifier:8050/api/v2/verifier/solidity/versions | head -c 120; echo
docker port fmx-explorer-verifier    # empty: no host port

# 2. ONLY the backend, with the new env. db, proxy and rewards-sidecar keep running.
#    The API answers 502 for about 1-2 minutes while it starts.
docker compose up -d --no-deps --force-recreate backend
until docker exec fmx-explorer-backend curl -sf -o /dev/null http://localhost:4000/api/v2/stats; do sleep 5; done
docker logs --since 3m fmx-explorer-backend 2>&1 | grep -i -m5 'verif\|error'
```

From anywhere, once the backend is up:

```sh
curl -s https://explorer.ferminux.net/api/v2/smart-contracts/verification/config |
  python3 -c 'import json,sys; v=json.load(sys.stdin)["solidity_compiler_versions"]; print(len(v), "v0.8.24+commit.e11b9ed9" in v)'
# expect: a count near 95, and True
```

Then verify our contracts, from a checkout with forge, python3 and curl:

```sh
explorer/scripts/verify-contracts.sh --check   # build + compare with the chain, submits nothing
explorer/scripts/verify-contracts.sh           # submit all 28
```

The script checks the compiler list first and stops if 0.8.24 is missing. It builds each
foundry project into a temp dir, compares every contract with its on-chain code (creation
input, or the deployed code for the two contract-created ones), skips and lists any that
do not match, then runs `forge verify-contract --verifier blockscout --verifier-url
https://explorer.ferminux.net/api/` with the constructor arguments taken from the creation
input, waits for the result, and reads the explorer's verdict back. A re-run skips what
is already verified. It needs no keys and sends no transactions.

If the edge (Cloudflare or the edge nginx) turns the uploads away, go around it: the
stack's proxy is published on the server's loopback (`FMX_EXPLORER_PORT=127.0.0.1:4000`)
and passes `/api` to the backend.

```sh
ssh -N -L 14000:127.0.0.1:4000 "$FMX_HOST" &
EXPLORER_URL=http://127.0.0.1:14000 explorer/scripts/verify-contracts.sh
```

Contract-created children are not in the list on purpose: AgentAccount clones are minimal
proxies that the explorer resolves to the verified AgentAccount, and agent tokens, factory
tokens and other pairs are created at run time.

### Rollback

```sh
cd /opt/ferminux/explorer
cp envs/backend.env.bak-verifier-YYYYMMDD envs/backend.env
cp docker-compose.yml.bak-verifier-YYYYMMDD docker-compose.yml
docker compose up -d --no-deps --force-recreate backend
docker rm -f fmx-explorer-verifier   # the verifier-compilers volume stays; `docker volume rm` it to reclaim disk
```

Contracts verified in the meantime stay verified: the source lives in the explorer's
database, not in the verifier.

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

- **Internal transactions are not indexed** — the `ferminux` node's public RPC exposes
  no `debug`/`trace` namespace. If a traced node becomes available, remove
  `INDEXER_DISABLE_INTERNAL_TRANSACTIONS_FETCHER` and point
  `ETHEREUM_JSONRPC_TRACE_URL` at it.
- **Contract verification** runs through the `smart-contract-verifier` service (see
  [Contract verification](#contract-verification)). The k8s manifests still have it off
  (`k8s/15-configmaps.yaml`); production runs compose.
- **No stats/charts microservice** — homepage charts are disabled
  (`NEXT_PUBLIC_HOMEPAGE_CHARTS=[]`).
- The frontend API-docs page (`/api-docs`) fetches its swagger definition from
  GitHub client-side if opened; core explorer pages are fully self-contained.
- First page of `/api/v2/blocks` can transiently show `"rewards": []` for
  seconds-old blocks (in-memory cache races the reward seeder; see above).
