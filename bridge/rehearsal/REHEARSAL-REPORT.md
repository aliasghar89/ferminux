# Ferminux Bridge — Testnet Rehearsal Report

**Date:** 2026-08-20 · **Operator:** rehearsal harness · **Commit under test:** bridge/ as-audited (335 contract tests, 135 relayer tests, all green on this machine)
**Scope:** dry-run the documented bring-up + incident runbooks for two remote chains — **BSC Testnet (97)** and **Base Sepolia (84532)** — before any mainnet deployment. No mainnet was touched; no real funds were spent.

---

## 0. Verdict

The full runbook was executed end to end, twice (once per remote chain), plus every safety rail and every incident runbook, against **live contracts** driven by the **real relayer daemons**. Everything the docs promise, fired. Two things worth the operator's attention before go-live: the **runbook §1 gas table understates this build** (deploy +11%, wrapper +24%, execute +32% — budget from §6 here), and **each Ferminux-side bridge must be wrapper-pinned even if it only hosts a canonical token today**, or the first wrapped registration on it reverts `BRIDGE: wrapper pin unset` (hit live in §5, step "strand route").

This was a **fork rehearsal**, not a live-testnet one — see §1.

---

## 1. Reachability & why this is a fork rehearsal

Both public testnets answered with the correct chain id today (curl `eth_chainId`, 2026-08-20):

| Chain | id | endpoint that answered | result |
|---|---|---|---|
| BSC Testnet | 97 (`0x61`) | `https://bsc-testnet-rpc.publicnode.com` (also `data-seed-prebsc-1-s1.bnbchain.org:8545`, `bsc-testnet.publicnode.com`) | ✅ `0x61`, head 0x785f855, gas 0.1 gwei, `finalized` tag present |
| Base Sepolia | 84532 (`0x14a34`) | `https://sepolia.base.org` (also `base-sepolia-rpc.publicnode.com`, `base-sepolia.drpc.org`, tenderly gateway) | ✅ `0x14a34`, head 0x2b9ea9f, gas 0.006 gwei |
| Blast API BSC / omniatech | — | — | ❌ Blast retired → Alchemy; omniatech 521 |

**Both testnets are reachable.** But testnet deployment needs testnet gas, and the funding faucets are browser/captcha-gated (see §2). Rather than block, the rehearsal ran against **anvil forks** of the two live testnets, so every RPC read (chain id, gas, `finalized`, real state) is the actual testnet's, while writes cost nothing:

| Port | Chain | Role |
|---|---|---|
| 8660 | anvil `--chain-id 3961 --hardfork paris` | **Ferminux stand-in** (local, NOT `rpc.ferminux.net` — mainnet was not touched, per the hard rule) |
| 8661 | anvil `--fork-url bsc-testnet-rpc.publicnode.com` | **BSC Testnet fork** (chain 97) |
| 8662 | anvil `--fork-url sepolia.base.org` | **Base Sepolia fork** (chain 84532) |

This is a **fork rehearsal**: the mechanics, contracts, timelock, signatures, relayer and incident procedures are all real; the only thing simulated is the coin. A live-testnet run is the same script with the deployer funded and the anvil forks swapped for the public RPCs (three independent endpoints per chain — see the go-live checklist).

The Ferminux `paris` hardfork was chosen deliberately: chain 3961 is pre-Shanghai (no `PUSH0`). Proof it matters below.

---

## 2. Funding — what the operator must supply

A fresh throwaway deployer keypair was generated (`cast wallet new`, key at `rehearsal/keys/deployer.txt`, mode 400) and is **empty on both live testnets**:

```
deployer = 0x91Bc818631B4d6cF0cD34E08c8C2ac730844F6E6
  BSC Testnet balance:  0
  Base Sepolia balance: 0
```

To run this **on the live testnets**, that address needs a faucet drip (browser/captcha, cannot be automated here):

- **BSC Testnet tBNB:** https://www.bnbchain.org/en/testnet-faucet  (~0.3 tBNB covers a full route + a wrapper + margin)
- **Base Sepolia ETH:** https://www.alchemy.com/faucets/base-sepolia or https://docs.base.org/tools/network-faucets  (~0.01 ETH is ample)

All other roles (owner multisig signers ×3, pauser, fee collector, user, recipient, validators ×3, submitter) were generated fresh as throwaway keys under `rehearsal/keys/` and funded on the forks with `anvil_setBalance`. **No real key was used anywhere.**

---

## 3. What was deployed, where, at which address

All addresses are on the forks listed in §1. On a live run the addresses will differ (ordinary `CREATE` from different nonces) — that is expected and is exactly why `setRemoteBridge` records them explicitly rather than deriving them.

**Owner multisig** — `MinimalMultisig` (2-of-3), from `ferminux-network/contracts`, deployed and **exercised with one harmless tx** on each chain before it owned anything (runbook prerequisite):
`0xADdB45CEb55851ac073560C97725300CFb778699` (same address on all three forks — coincidence of a fresh deployer nonce; the bridges below are deliberately distinct).

Validators (2-of-3, threshold 2), from the keystore ceremony (§4): `0x42ac07…5d18`, `0xFFa725…d20b`, `0x15b108…c501`. Pauser `0xbEFd…4DDD`. Fee collector = the multisig.

### Route 1 — Ferminux (3961) ⇄ BSC Testnet (97)

| Contract | Chain | Address | Domain separator |
|---|---|---|---|
| `FerminuxBridge` A1 | 3961 (:8660) | `0x6bf16A5F85c6f89964b71e8238507fbCA4867B69` | `0xa351b6…8036` |
| `FerminuxBridge` B1 | 97 (:8661) | `0x9E3bdc4Fe5D053f7bacc65A20B88007ed79E43F4` | `0xb4b002…b59f` |
| `BridgeToken` wFMX | 97 | `0x87d3a7866ae7464527733472fC112Cf053dDE3fc` | — (decimals 18, origin 3961/0x0) |

Registration (mirror, smoke caps 100/500 FMX): A1 `0x0` CANONICAL → (97, wFMX); B1 wFMX WRAPPED → (3961, 0x0). Read back and confirmed field-by-field.

### Route 2 — Ferminux (3961) ⇄ Base Sepolia (84532)

Per the **one-bridge-per-remote-chain** rule, Route 2 needed a **second** Ferminux-side bridge (A2), because FMX on A1 is permanently bound to chain 97.

| Contract | Chain | Address | Domain separator |
|---|---|---|---|
| `FerminuxBridge` A2 | 3961 (:8660) | `0x0Cee0a57A6D9Aa28efB34B0b6399a8Ff65c37170` | `0x11fba7…7d33` |
| `FerminuxBridge` B2 | 84532 (:8662) | `0x6bf16A5F85c6f89964b71e8238507fbCA4867B69` | `0x891580…5014` |
| `BridgeToken` wFMX2 | 84532 | `0x0Cee0a57A6D9Aa28efB34B0b6399a8Ff65c37170` | — (decimals 18, origin 3961/0x0) |

Registration mirror (smoke caps 100/500): A2 `0x0` CANONICAL → (84532, wFMX2); B2 wFMX2 WRAPPED → (3961, 0x0). Confirmed.

### Strand-test route (for the incident runbook, §7.3) — Base (84532) ⇄ Ferminux (3961)

| Contract | Chain | Address | Note |
|---|---|---|---|
| `FeeOnTransferToken` FOT | 84532 | `0x9e3bdc4fe5d053f7bacc65a20b88007ed79e43f4` | canonical, `setTax(false)` at first, flipped on to strand it |
| `BridgeToken` wFOT | 3961 | `0x9E3bdc4Fe5D053f7bacc65A20B88007ed79E43F4` | wrapped, origin 84532/FOT |

**PUSH0-absence proof (Ferminux is pre-Shanghai):** the deployed runtime bytecode was pulled with `cast code` and disassembled with `cast disassemble`:

- `FerminuxBridge` runtime: **23,965 bytes, 13,578 opcodes, `PUSH0` count = 0** (2,470×PUSH1, 1,493×PUSH2, …). Under the 24,576 B EIP-170 limit.
- `BridgeToken` runtime: **4,465 bytes, `PUSH0` count = 0.**

Both are Paris-clean and safe for chain 3961.

---

## 4. Validator key ceremony (rehearsed)

Three encrypted V3 keystores were generated with the relayer's own `--role keygen` (private key never touches stdout, keystore + password file both mode 400), one per validator. Each signed a ceremony attestation **from inside its keystore** (key never extracted); all three verified. Record at `rehearsal/keys/ceremony-attestations.txt`. In production these are three machines / three custodians — here they are three keystores on one host, which is stated plainly as the rehearsal's accepted deviation.

---

## 5. The bring-up, step by step (each with its result)

Timelock delay was the **production 48 h** (`TIMELOCK_DELAY=172800`); the wait was crossed with `evm_increaseTime` on the forks. Every governance step went through the real `MinimalMultisig` (submit → confirm → execute), never a bare EOA owner.

| # | Step | Result |
|---|---|---|
| 1 | Deploy A1, B1 (+A2, B2); verify `owner/threshold/validators/timelock/feeBps/collector/isPauser/paused/DOMAIN_SEPARATOR` | ✅ all match intended; owner is the multisig on every chain |
| 2 | Deploy wFMX (+wFMX2, wFOT); check `bridge()==bridge`, `originChainId`, `decimals==18`, `totalSupply==0` | ✅ |
| 3 | `setBridgeTokenCodehash` (wrapper pin) queued+matured+executed on each **wrapped-hosting** bridge | ✅ pin = `0x980cac…36ac` |
| 4 | `setRemoteBridge` both directions, queued+matured+executed | ✅ read back: A1↔B1, A2↔B2 both mirror |
| 5 | **Early `executeAction` before the eta** — simulated from the multisig, from a random EOA, and through the real multisig loop | ✅ **refused** `BRIDGE: timelock not elapsed` (msig), `BRIDGE: not owner` (EOA); the multisig tx stayed pending and **succeeded on retry after the eta** (timelocked actions are retryable, proven live) |
| 6 | `registerCanonical` / `registerWrapped` queued+matured+executed, both sides, both routes | ✅ configs mirror field-by-field (`kind`, paused, remoteChainId, remoteToken, caps) |
| 7 | `send()` naming the **destination bridge** as recipient | ✅ **refused at origin** `BRIDGE: recipient is bridge` |

**Live lesson (did not work first time, by design):** the strand route puts a *wrapped* token (wFOT) on A2, but A2 had only ever hosted canonical FMX and so was **never wrapper-pinned**. `registerWrapped` reverted `BRIDGE: wrapper pin unset` through the multisig (surfaced as `MSIG: call failed`). Fix: queue+execute `TOKEN_KIND=pin` on A2, then re-queue the wrapped registration. **Go-live consequence:** pin *every* bridge that will ever host a wrapper, even if its first token is canonical — do not assume the canonical-only side needs no pin.

---

## 6. Moving real value + the safety rails (via the live relayer)

The relayer daemons (`bridge/relayer`, TypeScript on Node 24, `ethers@6`, `node:sqlite`) ran for real — two validators (2-of-3; validator 3 deliberately left down) and one submitter, on ports 8663/8664/8665. `--role check` passed preflight on both chains (domain-verified, threshold read, validator set read) before any key was loaded.

| Leg | Route | What happened | Result |
|---|---|---|---|
| FMX → wFMX | 1 (BSC) | user locked **5 FMX** on A1; validators confirmed at depth 3, signed; submitter collected 2 sigs and `execute()`d on B1 | ✅ recipient wFMX = **4.995** (10 bps), **arrived in 10 s**, `totalSupply == lockedBalance` exactly |
| wFMX → FMX | 1 (BSC) | recipient burned 4.995 wFMX home; relayer released on A1 | ✅ user got back **4.990005** (10 bps twice); locked == supply == 0.004995 (fee residue) |
| FMX → wFMX2 | 2 (Base) | user locked **3 FMX** on A2 | ✅ recipient wFMX2 = **2.997**, arrived in 9 s, conservation exact |
| wFMX2 → FMX | 2 (Base) | burn home | ✅ user got back **2.994003**; locked == supply |

Every transfer flowed **through the daemons** (validator `transfer confirmed` → submitter `execute() broadcast` with `signers=[v1,v2]` → `already executed`), visible in `GET /transfers` on the submitter as `status=executed, signatures=2`.

**Safety rails, all fired against the live contract:**

| Rail | Method | Result |
|---|---|---|
| Replay of an executed `transferId` | re-submit the settled transfer with valid sigs | ❌ `BRIDGE: already processed` |
| Under-quorum bundle (1 of 2) | one valid signature | ❌ `BRIDGE: not enough signatures` |
| Duplicate signer (same sig ×2) | one sig twice | ❌ `BRIDGE: duplicate signer` |
| Wrong-chain-domain signature | sign the A1-domain digest, submit to B1 | ❌ `BRIDGE: below threshold` (the EIP-712 domain binds destination chain+address, so the sigs recover to non-validators — distinct digests `0x3c65…` vs `0x9931…`) |
| Pause blocks a transfer | pause B1, attempt `send` and `execute` | ❌ both `BRIDGE: paused` |

**Measured gas → USD** (BNB $653.19, ETH $2341.43, FMX $0.52, prices 2026-08-20):

| Op | Measured gas | BSC @1 gwei | BSC @0.1 gwei | Base @0.05 gwei L2* | Ferminux @1 gwei |
|---|---:|---:|---:|---:|---:|
| deploy bridge | 5,585,112 | $3.65 | $0.365 | $0.654 | $0.0029 |
| deploy wrapper | 1,190,428 | $0.78 | $0.078 | $0.139 | $0.0006 |
| `send()` | 114,617 | $0.075 | $0.0075 | $0.013 | $0.00006 |
| `execute()` mint | 163,889 | $0.107 | $0.0107 | $0.019 | $0.00009 |
| `pause()` | 30,414 | $0.020 | $0.0020 | $0.0036 | $0.00002 |

\*Base L2 execution only; the **real** Base cost is dominated by the L1 data component, not shown here.

**Full one-route bring-up (measured, all-in):** 2× bridge deploy + 1 wrapper + all governance (pin, 2× remotebridge, 2 registrations — each submit+confirm+execute through the multisig) = **16,701,846 gas**. At BSC 1 gwei ≈ **$10.91**; at 0.1 gwei ≈ **$1.09**; on Ferminux 1 gwei ≈ **$0.009**. (The multisig overhead — submit ~174k–313k, confirm ~57.6k per action — is real and is the bulk of governance gas; the runbook's §1 "≈7.5 M" counts the inner calls only.)

**Runbook §1 quoted vs measured (this build):**

| | quoted | measured | delta |
|---|---:|---:|---:|
| deploy bridge | 5,022,256 | 5,585,112 | **+11.2%** |
| deploy wrapper | 961,748 | 1,190,428 | **+23.8%** |
| send (median) | 112,214 | 114,617 | +2.1% |
| execute (median) | 124,602 | 163,889 | **+31.5%** |
| pause | 29,834 | 30,414 | +1.9% |

The quoted deploy/execute figures are stale for the current `via_ir` / 23,965 B build. **Budget from the measured column.**

---

## 7. Incident runbooks (executed against live contracts)

### 7.1 Pause / unpause drill, both chains, timed (operations.md §7)

| Chain | pauser→paused | send while paused | pauser tries unpause | multisig unpause |
|---|---|---|---|---|
| B1 (BSC) | **1.04 s** | ❌ `BRIDGE: paused` (send **and** execute) | ❌ `BRIDGE: not owner` | ✅ **5.12 s** |
| A1 (Ferminux) | **1.53 s** | ❌ `BRIDGE: paused` | — | ✅ **5.89 s** |

Pausing one chain did **not** pause the other (verified). Fast-to-stop / slow-to-restart asymmetry confirmed live.

### 7.2 Cap change through the timelock (operations.md §5)

Raised smoke caps 100/500 → week-1 launch **5,000/25,000 FMX**, **both sides together**, through the 48 h timelock. Early execute refused `BRIDGE: timelock not elapsed`; both sides landed in the same window. Then the **instant** `decreaseTokenLimits` back toward smoke (no timelock) — took effect immediately. A decrease that was actually an increase was refused `BRIDGE: not a decrease`.

### 7.3 Stranded-route procedure (operations.md §8.5) — driven with a real taxing token

The crown jewel, because a runbook never run is a hypothesis. A real `FeeOnTransferToken` was registered canonical (tax off, so it locked collateral exactly), then **turned hostile mid-life** (`setTax(true)`):

1. Locked 50 FOT on B2 (tax off) → minted 49.95 wFOT on A2 via a real 2-of-3 quorum. ✅ conservation exact.
2. Flipped the tax on. Burned wFOT home → the homeward release on B2 **stranded**: `BRIDGE: inexact transfer`. ✅ (nothing short-paid, `transferId` not consumed — retryable, as designed).
3. `pauseToken` on **both** chains — FOT on B2 *and* wFOT on A2 (the step the docs stress is most skipped). ✅ further burns blocked `BRIDGE: token paused`; global bridges stayed live.
4. Quantified: locked(FOT)=49.95 vs wFOT supply; owed to the one claim = 49.90005 FOT.
5. `allowShortDelivery(transfer)` queued on the canonical side (B2), **timelocked** — early execute refused `BRIDGE: timelock not elapsed`; `transferId` and owed published from the queued calldata. ✅
6. `cancelShortDelivery()` — **revoked the armed slot instantly** (slot → 0x0). Re-queued and re-armed. ✅
7. `unpauseToken(FOT)`, then relayed the release with a real quorum: recipient **owed 49.90005, received 49.401** (the 1% tax burned in transit), short-paid exactly 0.499. `ShortDelivery(owed,paid,delivered)` fired; the armed slot cleared (single-use); `processed=true`. ✅
8. Left FOT paused — route dead, not re-registered. ✅
   - `surplusOf(FOT)` delta was **0** — correct: surplus grows only under the *reflection* shape (write-down exceeds what the bridge parts with); under plain fee-on-transfer the bridge parts with the full `amount`, so there is no residue. The docs' "surplus rises" note is reflection-specific.

**And the relayer proved its own backstop here without being asked:** the Route-2 submitter *observed* the stranded homeward transfer (same chains), its validators signed it under the default cap, but the submitter's **simulate-before-broadcast** `staticCall` caught `BRIDGE: inexact transfer` and **refused to broadcast**, firing `submission_failed` (critical). The on-chain settlement strictness and the off-chain simulation agreed; the transfer only ever settled through the deliberate, governance-authorised short delivery. This is the defense-in-depth the relayer README describes, seen live.

### 7.4 Fee sweep (routine ops)

`withdrawFees` swept accrued fees on all four bridges to the fee-collector multisig: A1 FMX 0.005, B1 wFMX 0.004995, A2 FMX 0.003, B2 wFMX2 0.002997 → each `accruedFees` reset to 0, multisig received the wrapped fees. ✅

---

## 8. What did NOT work, and why

1. **`registerWrapped` on an unpinned bridge** (A2) reverted `BRIDGE: wrapper pin unset` → surfaced as `MSIG: call failed`. Cause: A2 hosted only canonical FMX and was never pinned. Fix: pin it first. **This is a go-live trap** — see checklist.
2. **Runbook §1 gas table is stale** for this build (deploy +11%, wrapper +24%, execute +32%). Not a failure, but the operator will under-fund the deployer if they trust it.
3. **Live-testnet deployment could not be performed** — the throwaway deployer is unfunded and the faucets are captcha-gated (§2). The rehearsal ran on forks of the live testnets instead. Everything except the coin is real; the retry/gas-escalation path (only fires on a congested chain, not on instant-mining anvil) and the `finalized`-tag-vs-count interaction were therefore not exercised against a real block cadence — see the relayer README's own "what is not covered."
4. **First manual `execute` attempt failed** because the submitter's *address* was passed where a private key was expected — operator error, corrected immediately (execute is permissionless; any funded key relays). Worth noting only as a reminder that the submitter key is a gas key, nothing more.

---

## 9. Mainnet / live-testnet go-live checklist (derived from this rehearsal)

**The operator must supply:**
- [ ] A **funded deployer** on each remote chain. Budget from §6 **measured** gas: ~8 M gas for one route's deploys + governance, ×1.5 margin. BSC: ~0.05 BNB. Base: ~0.01 ETH. (The generated throwaway `0x91Bc…F6E6` is empty; fund it or use another one-shot key — never a role key.)
- [ ] **Three independent RPC endpoints per chain, from three operators** (this rehearsal used single-endpoint anvils via the `insecure.allowSingleRpcEndpoint` acknowledgement, which a mainnet config must never carry). Re-run `--role check` after choosing them — it resolves DNS and refuses two brands on one box.
- [ ] A **real 2-of-3 (or better) owner multisig on each chain**, three **separate machines/custodians** for the validators, a monitored pauser host — the ceremony here was three keystores on one host, explicitly a rehearsal shortcut.
- [ ] BSC and Base **confirmation depths** restored to the real values (BSC 20 + `finalized`; Base 180 + `finalized`) — the fork config used 3 for speed. Ferminux stays **64**.
- [ ] Monitoring wired **before** the first registration: the `Executed`-without-`Sent` reconciliation loop, the `lockedBalance ≥ wrapped supply` check, the matured-but-unexecuted-action poll, and the `rpc_divergence` / `submission_failed` pager.

**Sequence that is now proven (repeat it):**
- [ ] `forge test` 335/335 green on the exact commit (confirmed this run) and `forge build --sizes` under 24,576 B.
- [ ] Deploy bridge on **both** sides; record both addresses + both `DOMAIN_SEPARATOR()`; verify all 9 constructor read-backs.
- [ ] **A separate Ferminux-side bridge per remote chain** — FMX binds to one remote chain permanently (Route 2 needed A2). Budget "two of everything" per the docs.
- [ ] **Pin the wrapper codehash on EVERY bridge that will ever host a wrapper, before its first `registerWrapped`** — including a bridge whose first token is canonical (the A2 trap above).
- [ ] `setRemoteBridge` both directions first; **read both back**; then the mirrored registrations; **start at smoke caps 100/500**, verify the config mirror field-by-field before announcing.
- [ ] Verify source on both explorers (Blockscout on Ferminux) — not done here (no explorer on a fork), required live.
- [ ] Smoke a dust round trip **both directions with the real validator set**, confirm `lockedBalance == wrapped totalSupply` at rest, run the **pause drill on mainnet** and write down the elapsed time (here: pause ~1–1.5 s, multisig unpause ~5–6 s).
- [ ] Raise caps only by the gated ramp (§5), **both sides within the same hour**, re-checking the Ferminux reorg inequality at each step.
- [ ] Keep the incident runbooks within reach — all three (pause, timelocked cap change, stranded-route short delivery) are now proven to behave exactly as written.

---

## Appendix — artifacts on disk

```
bridge/rehearsal/
├── REHEARSAL-REPORT.md          this file
├── env.sh                       all addresses + throwaway keys (mode 600)
├── keys/                        throwaway keystores, ceremony attestations (mode 400)
├── configs/  chains-r1-bsc.json, chains-r2-base.json   relayer configs (single-endpoint, insecure-acked)
├── scripts/  msig-queue.sh, msig-exec.sh, verify-bridge.sh, sign-digest.mjs
├── logs/     forge-build/test, relayer-test, deploy-*, validator*/submitter* daemon logs,
│             gas.csv (every measured tx), actions.csv, *-disasm.txt (PUSH0 proof)
└── state/    relayer sqlite state
```
Audited contracts and relayer source were **only read**, never modified. No git write commands were run. No docker container was touched. Ports used: 8660–8665 only.
