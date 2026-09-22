# LP locking — path per chain, and how a buyer verifies it

Unlocked LP in a personal wallet is, to any competent buyer, indistinguishable
from a rug waiting to happen: whoever holds the LP can withdraw both sides of
the pool at any moment. Locking the LP is therefore not optional polish — it
is the difference between "a market" and "a trap that hasn't sprung yet".

Two viable paths. The honest trade-off:

## Option A — our own `LiquidityLocker` (from `../dex/contracts`)

A ~250-line, self-contained, **admin-free** time-lock: no owner, no pause, no
fee, no upgrade path, no escape hatch. Unlock times can only be pushed later.
Lock history is permanent and enumerable (`locksForToken`). It is covered by
the DEX test suite (unit + invariant tests, and re-proven in every fork
rehearsal here: withdrawal before maturity reverts `LOCKER: still locked`).

- **Pros:** zero trust in third parties, zero fees, identical behaviour on
  every chain, bytecode we compiled ourselves (solc 0.8.24, paris), source
  verification makes every claim checkable in the explorer UI.
- **Cons:** aggregator badges don't know it. DexScreener/DEXTools/GoPlus show
  "liquidity locked" automatically only for lockers they recognize (UNCX,
  Team Finance, PinkLock). With our locker, buyers must follow our proof
  links instead of seeing a green badge.

## Option B — an established third-party locker

UNCX Network (formerly Unicrypt), Team Finance, and PinkLock are the
recognized standards; screeners render their locks as a badge automatically,
which is worth real credibility with retail buyers on BSC in particular.

- **Pros:** instant third-party recognition; buyers already trust the brand.
- **Cons:** service fees (flat + sometimes a % of LP), larger contract
  surface owned by someone else, and per-chain product coverage varies.
- **Addresses are NOT pinned in this repo** — obtain them only through the
  official apps (`app.uncx.network`, `team.finance`, `pinksale.finance`),
  cross-checked against the explorer's verified-contract label, at execution
  time. Never take a locker address from a search result, a Telegram chat, or
  this file's git history.

## Recommendation

| Chain | Path | Why |
|---|---|---|
| BSC | **Option B** (UNCX or PinkLock) if retail optics matter; Option A otherwise | BSC retail lives on DexScreener/DEXTools badges |
| Ethereum | Option A | gas-cheap single deploy (~1.66M gas), audience checks contracts directly |
| Base | Option A | same |
| Arbitrum | Option A | same |
| Polygon | Option A | same |

Either way: lock **all** LP the treasury holds, for **12 months minimum**
(shorter locks read as a planned exit), and extend before maturity becomes
imminent. Consider `transferLock` to the MinimalMultisig
(`0x910BD467D8576277f8f96DF47428377FFD94fEfe` on Ferminux — deploy a remote
multisig equivalent on the target chain) so no single key controls the
matured lock.

## Executing Option A

```sh
PRIVATE_KEY=0x... node scripts/lock-lp.mjs --chain bsc --pair 0xPAIR \
    --amount all --unlock 2027-09-01 --broadcast --yes
```

Deploys the locker (or reuses one via `--locker`), approves, locks, prints
the proof block. Measured gas: deploy 1,656,405 + approve ~46k + lock
~224.5k.

## Proving the lock publicly (step by step)

A buyer must be able to verify with zero trust in us:

1. **Verify the locker's source on the chain explorer** so its read tab works
   for everyone:

   ```sh
   forge verify-contract <LOCKER_ADDR> src/LiquidityLocker.sol:LiquidityLocker \
       --chain-id <id> --compiler-version 0.8.24 --optimizer-runs 200 \
       --evm-version paris --etherscan-api-key <KEY>
   ```

   Run from `../dex/contracts` (that repo is the source of truth for the
   bytecode). Note: `foundry.toml` there strips CBOR metadata
   (`bytecode_hash = "none"`), so Etherscan may report a "partial/similar
   match" rather than "exact match" — that is expected and fine; the code
   hash of the deployed runtime is what matters.

2. **Publish three links** in every announcement, docs page, and the token's
   explorer info:
   - the pair address (the LP token),
   - the locker address with its verified source,
   - the lock id.

3. **What the buyer checks** (also printed by `lock-lp.mjs` after locking):

   ```sh
   # the lock exists, with amount and unlock date:
   cast call <LOCKER> "locksForToken(address)((uint256,address,address,uint256,uint64,uint64,bool)[])" <PAIR> --rpc-url <public rpc>

   # the LP really sits in the locker, not in a wallet:
   cast call <PAIR> "balanceOf(address)(uint256)" <LOCKER> --rpc-url <public rpc>

   # compare against total LP supply — the locked share should be ~100%:
   cast call <PAIR> "totalSupply()(uint256)" --rpc-url <public rpc>
   ```

   In the explorer UI (post-verification): open the locker → *Contract* →
   *Read Contract* → `locksForToken(pair)` and `totalLockedForTokenAt(pair,
   <now>)`; open the pair → *Holders* → the locker should be the dominant LP
   holder.

4. **What the buyer should NOT be told**: "liquidity locked" while the
   treasury separately holds a large unlocked FMX position is technically
   true and materially misleading — the lock stops LP withdrawal, it does not
   stop treasury FMX from being sold into the pool. Say both facts together.
   The premine is 30,000,000 FMX (verifiable in the Ferminux genesis file and
   on the Ferminux explorer); any listing announcement that omits it will be
   found out by the first person who checks.
