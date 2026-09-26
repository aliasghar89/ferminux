# Ferminux Launchpad

"Launch your coin" web UI for Ferminux Network (chain id **3961**, native coin
**FMX**). Vite + React + TypeScript, ethers v6 bundled from npm — the built
`dist/` is fully static and self-contained (no CDNs, no third-party chain
services).

## What it does

- **Wallet connect**: Ferminux Wallet (the web wallet, nothing to install), any
  injected wallet, or WalletConnect when built with `VITE_WC_PROJECT_ID` (see
  `shared/fxwallet/README.md`), including one-click
  **"Add Ferminux Network"** (`wallet_addEthereumChain`: chainId `0xF79`, FMX,
  `https://rpc.ferminux.net`, `https://explorer.ferminux.net`) and a
  wrong-network guard with "Switch to Ferminux".
- **Launch form** — name, symbol, decimals (default 18), initial supply, max
  supply (0 = uncapped), mintable toggle. Calls `TokenFactory.launch` with
  `msg.value` = the **live** `launchFee()` read from the contract (the UI shows
  "10 FMX" straight from chain — never hardcoded). Client-side validation
  mirrors the contract's `require`s. Success screen shows the new token
  address, tx hash and explorer links.
- **Token registry** — paginated via `tokensPage(offset, limit)`, newest
  first, with per-token trust badges:
  - **Factory verified** — the row comes from the on-chain factory registry
    (known, unmodified bytecode) — always shown;
  - **Ownership renounced** — `owner() == 0x0`, nobody can mint again;
  - **Fixed supply** — launched with `mintable == false`;
  plus creator, created date and live supply / cap.
- **No wallet needed to browse** — the list and the fee are read through the
  configured RPC endpoint; the wallet is only required to launch.

## Layout

```
launchpad/
├── src/
│   ├── config.ts             FACTORY_ADDRESS / RPC_URL / EXPLORER_URL + env overrides
│   ├── lib/factory.ts        the ONLY contract data layer (shared with the e2e test)
│   ├── lib/wallet.ts         EIP-1193 helpers (connect / add / switch chain)
│   ├── lib/connector.ts      the wallet choice (Ferminux Wallet, injected, WalletConnect)
│   ├── App.tsx               shell: header, tabs, wallet state
│   └── components/           LaunchForm.tsx, TokenList.tsx
├── scripts/e2e.mjs           e2e data-layer test (spawns its own anvil on :8548)
└── dist/                     static build output (after `npm run build`)
```

## Configuration

`src/config.ts` defaults to mainnet and honors build-time env overrides
(see `.env.example`):

| Variable | Default |
|---|---|
| `VITE_FACTORY_ADDRESS` | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| `VITE_RPC_URL` | `https://rpc.ferminux.net` |
| `VITE_EXPLORER_URL` | `https://explorer.ferminux.net` |

The default factory address is the canonical `DeployCore.s.sol` address
(deployer nonce 2). **After the real mainnet deployment, confirm the address
and set `VITE_FACTORY_ADDRESS` at build time if it differs.** Env vars are
baked in by Vite at build time — rebuild after changing them.

## Dev / build (tested on this machine)

```sh
cd <repo>/launchpad
npm install
npm run dev        # dev server on http://localhost:8548 (see port note below)
npm run build      # tsc --noEmit && vite build  ->  dist/
ls dist            # index.html + assets/ — the whole deployable site
npm run preview    # serves dist/ on http://localhost:8548 to verify the build
```

Verified: `npm run build` succeeds (vite 5.4, 183 modules, ~148 kB gz JS) and
`curl http://localhost:8548/` against `npm run preview` returns the app shell.

**Port note:** this workstation reserves **8548** for the launchpad component,
so the dev server, `preview` **and** the e2e's throwaway anvil all use it —
don't run two of them at once. The live devnet on 8545/8546 is never touched.

## E2E data-layer test

```sh
cd <repo>/launchpad
npm run e2e        # = node scripts/e2e.mjs
```

The script (Node 26 runs the app's TypeScript directly):

1. spawns a throwaway `anvil --port 8548 --chain-id 3961` (and kills it when done);
2. deploys the **real** `TokenFactory` from the contracts project's forge
   artifact (`../contracts/out/TokenFactory.sol/TokenFactory.json`,
   feeCollector = anvil account #1) — run `forge build` in
   `<repo>/contracts` first if `out/` is missing;
3. imports `src/lib/factory.ts` **unchanged** — the exact module the UI uses —
   and asserts: `launchFee()` == 10 FMX and renders as "10 FMX"; `launch`
   paying the live fee returns the token address from the `TokenLaunched`
   event; the fee is forwarded to the collector; `tokensPage` newest-first
   pagination (multiple pages + past-the-end); registry fields (name, symbol,
   creator, createdAt); trust-badge logic — factory-verified always,
   fixed-supply for `mintable == false`, and ownership-renounced flips after
   `renounceOwnership()` makes `owner() == 0x0`; underpaying reverts with
   `FACTORY: fee`.

Last run on this machine: **26 passed, 0 failed**.

## Deploy to nginx

The build is a plain static SPA — any nginx can serve it:

```sh
npm run build
rsync -a dist/ user@server:/var/www/launchpad/
```

```nginx
server {
    listen 443 ssl http2;
    server_name launch.ferminux.net;   # or serve under any host/path

    root /var/www/launchpad;
    index index.html;

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location / {
        try_files $uri /index.html;        # SPA fallback
    }
}
```

No server-side code, no proxying required — the browser talks straight to
`https://rpc.ferminux.net`. If the RPC node enforces CORS, allow the
launchpad origin there.

## Notes

- ethers v6 is a bundled npm dependency; the shipped page loads **no** external
  scripts, fonts or styles.
- `src/lib/factory.ts` is deliberately free of browser/Vite globals so the e2e
  test exercises the exact production code paths.
- Design: institutional dark, system font stack (Inter where installed), 6px
  radius, tabular numerals.
