# Ferminux Citizens (FMXC)

One-of-one FRC-721 portraits on chain 3961, priced by rarity tier. The collection grows: each folder of
artwork the owner sends becomes the next token ids. Contract: `agents/contracts/src/FerminuxCitizens.sol`.

| Tier | Price | Tier index on chain |
|---|---|---|
| Common | 50 FMX | 0 |
| Rare | 100 FMX | 1 |
| Epic | 250 FMX | 2 |
| Legendary | 500 FMX | 3 |

## Files

| Path | What it is |
|---|---|
| `tiers.json` | **The single source of truth.** `collection`: name, symbol, base URL, tier prices (whole FMX), royalty, series descriptions, showcase ids. `tokens`: one entry per id with the source file, its sha256, name, tier, series, traits and `needsReview`. |
| `ingest.mjs` | Appends a folder as the next ids: copies each original to `images/<id>.jpg`, encodes `images/<id>-{256,512}.{avif,webp}`, adds placeholder entries with `needsReview: true`. |
| `build-meta.mjs` | Regenerates `meta/<id>.json`, `collection.json` and `contract.json` from `tiers.json`. `--check` writes nothing and fails on anything stale or unreviewed. |
| `build-og.mjs` | Mosaics from `collection.showcase`: `images/collection.jpg` (1024², marketplace avatar), `images/banner.jpg` (1400×350) and `web/public/assets/citizens-og.jpg` (1200×630 share card). |
| `meta/<id>.json` | What `tokenURI(id)` points at: `https://ferminux.net/nft/citizens/meta/<id>.json`. |
| `collection.json` | Every token's metadata plus `id`, in one array, for the gallery at `/nfts/citizens/`. |
| `contract.json` | Collection-level metadata behind `contractURI()`. |

The name and symbol live only in `tiers.json` (`collection.name`, `collection.symbol`). The deploy script,
the metadata and the page all read them from there, so a rename before deploy is one edit plus
`node build-meta.mjs` and a web build. After deploy the on-chain name is fixed.

## Adding the next folder

```sh
cd agents/nft/citizens
node ingest.mjs "<folder>" --start <next id> [--series "<Series>"]   # e.g. --start 137
#   review every new entry in tiers.json: name, tier, series, traits; then needsReview: false
#   --series fills one series for the whole folder; a folder holding two (folder three: Professions, Vanguard)
#   gets the second one per entry during that review, and each series needs a line in collection.series
node build-meta.mjs && node build-meta.mjs --check
```

Then, in this order (metadata before the ids exist on chain, so no token ever points at a 404):

1. Copy the files to the site: `rsync -av --exclude '*.mjs' --exclude README.md --exclude tiers.json
   agents/nft/citizens/ <user>@<web-host>:<site-root>/nft/citizens/`
2. Append the ids on chain as a curator (the deployer key):
   ```sh
   cd agents/contracts
   CITIZENS=$(jq -r .citizens ../deployments-citizens.3961.json) \
   forge script script/DeployCitizens.s.sol:AppendCitizens --rpc-url https://rpc.ferminux.net \
     --keystore "$KEYSTORE" --password-file "$KEYSTORE_PASSWORD" --sender <curator address> \
     --broadcast --with-gas-price 2gwei --priority-gas-price 1gwei
   ```
   About 22,000 gas per Rare/Epic/Legendary id and 2,500 per Common id (tier 0 is the empty slot),
   plus ~35,000 per call: `appendTokens` for ids 1-136 took 1,616,714 gas on the fork.
3. The page at `/nfts/citizens/` reads `totalIds()` from the contract, so the new ids appear without a web
   release. Rebuild the web only if `collection.showcase` or the copy changed.

## Deploy (chain 3961)

Proved end to end on an anvil fork: `agents/contracts/script/citizens-fork-e2e.sh` deploys as the real
deployer, mints one id of every tier, appends a later batch as curator, has the multisig accept ownership
and withdraws to the treasury. Nothing leaves 127.0.0.1.

What `DeployCitizens` does, in 4 transactions from the deployer:

1. `new FerminuxCitizens(name, symbol, deployer, prices, base/meta/, base/contract.json, treasury, royaltyReceiver, 500)`
2. `appendTokens(tiers of ids 1..N)` from `tiers.json`
3. `grantCurator(deployer)`
4. `transferOwnership(owner)`: the owner of FerminuxAgents (read on chain; the governance multisig
   `0x910BD467D8576277f8f96DF47428377FFD94fEfe`). The treasury defaults to that same address, because
   FerminuxAgents pays its proceeds to its owner (`TREASURY=<address>` overrides it). The royalty receiver is
   `collection.royaltyReceiver` in `tiers.json`, the `fee_recipient` that `contract.json` publishes; the script
   refuses a `ROYALTY_RECEIVER` that differs from it, so change it in `tiers.json` and run `build-meta.mjs`.

```sh
cd agents/contracts
forge script script/DeployCitizens.s.sol:DeployCitizens --rpc-url https://rpc.ferminux.net \
  --keystore "$KEYSTORE" --password-file "$KEYSTORE_PASSWORD" \
  --sender 0x34f5366014EF292fd5ff9FFDE81d47819EF65cFC \
  --broadcast --slow --with-gas-price 2gwei --priority-gas-price 1gwei -vvv
```

`KEYSTORE` is the community wallet's keystore (the key that deployed FerminuxAgents). Gas measured on the
fork at 136 ids: **4,583,492 gas** for the four transactions (create 2,871,374; append 1,616,714;
grantCurator 47,619; transferOwnership 47,785), about **0.0046 FMX** at the 1 gwei tip
(base fee is single-digit wei); `--with-gas-price 2gwei` caps it at 0.0092 FMX. The script writes
`agents/deployments-citizens.3961.json` (`citizens`, `citizensDeployBlock`); the web build reads it.

The multisig then finishes the hand-over (about 255,000 gas across three calls):

```sh
C=$(jq -r .citizens ../deployments-citizens.3961.json); MSIG=0x910BD467D8576277f8f96DF47428377FFD94fEfe
TXID=$(cast call $MSIG "transactionCount()(uint256)" --rpc-url https://rpc.ferminux.net)
cast send $MSIG "submit(address,uint256,bytes)" $C 0 $(cast calldata "acceptOwnership()") \
  --rpc-url https://rpc.ferminux.net --keystore "$OWNER1_KEYSTORE" --password-file "$OWNER1_PASSWORD" \
  --gas-price 2gwei --priority-gas-price 1gwei                               # owner 1 proposes (auto-confirms)
cast send $MSIG "confirm(uint256)" $TXID --rpc-url https://rpc.ferminux.net \
  --keystore "$OWNER2_KEYSTORE" --password-file "$OWNER2_PASSWORD" --gas-price 2gwei --priority-gas-price 1gwei
cast send $MSIG "execute(uint256)" $TXID --rpc-url https://rpc.ferminux.net \
  --keystore "$OWNER2_KEYSTORE" --password-file "$OWNER2_PASSWORD" --gas-price 2gwei --priority-gas-price 1gwei
cast call $C "owner()(address)" --rpc-url https://rpc.ferminux.net           # = MSIG
```

Until the multisig accepts, the deployer is still the owner. Minting is open from the first block, so copy the
metadata to the site (step 1 of "Adding the next folder") before the deploy.

### After deploy: where the address goes

| Surface | Change | Before it |
|---|---|---|
| ferminux.net `/nfts/citizens/` | nothing to edit: `agents/web/scripts/gen-config.mjs` reads `agents/deployments-citizens.3961.json`; rebuild and rsync the web | art browsable, "Minting opens soon" |
| Explorer | add `{ "address": "<C>", "name": "Ferminux Citizens (FMXC)", "short": "Ferminux Citizens", "section": "agents", "kind": "token", "abi": "FerminuxCitizens", "deployBlock": <block>, "mintUrl": "https://ferminux.net/nfts/citizens/?id={id}" }` to `explorer/web/src/data/contracts.3961.json`, then `npm run book` and a build (tier styling, `TokenMinted` story lines and "of N" work from the Tier trait and `totalIds()` without it) | generic FRC-721 page |
| Wallet | set the FMXC `address` in `wallet-web/src/lib/nft.ts` `KNOWN_COLLECTIONS` | skipped (explorer index still finds holdings) |
| Gateway / SDK | add the address next to `nft` in `agents/gateway/src/constants.ts` and a discovery line in `discovery.ts`; SDK `fmx.citizens` if agents should mint | the static `llms.txt` / `llms-full.txt` describe the collection without an address |

## Roles

| Who | Can |
|---|---|
| Owner (multisig) | set tier prices, pause/unpause, treasury, royalty (max 10 %), base URI and contract URI until `freezeMetadata()`, `lockSupply()` (forever), grant/revoke curators, `reserve(ids, to)` free mints, everything a curator can |
| Curator (deployer key) | `appendTokens(tiers)`, `setTier(id, tier)` on an unminted id, `withdraw()` (always to the treasury) |
| Anyone | `mint(id)` with exactly `price(id)`; a tier priced 0 is not for sale |
