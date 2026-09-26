# Ferminux Staking & Node Participation — Design

> **Status, 2026-09-26: historical design, superseded.** This was written on 2026-08-20,
> before the authority fork. Since block 160,000 chain 3961 runs Clique proof-of-authority:
> a set of authorised signers confirms a block every 7 seconds, and the foundation operates
> that set today. **There is no proof-of-stake hand-off at block 4,500,000 or at any other
> block**, and nothing in this repository schedules one. The "PoS fork", "validator-track",
> `getValidators()` and slashing sections below describe a plan that was dropped; they are
> kept as a record, not as a roadmap. The staking contracts in `staking/contracts` are not
> deployed on chain 3961. The validator programme being built now is a separate design
> (checkpoint validators that check blocks and do not produce them): see
> `agents/contracts/src/validators/` and <https://ferminux.net/validators/>. Wherever this
> document says mining, miners or hashrate, it describes the chain before block 160,000.

**Status (original):** DESIGN — approved economics required before any Solidity is written.
**Author:** economist/architect agent, 2026-08-20.
**Scope (original):** FMX staking on the pre-fork chain (3961), node-operator program, and a
hand-off to a stake-based engine at block 4,500,000 that was later dropped (see the status note).

This document is deliberately honest. Where a mechanism is trusted rather than
trustless, it says so. Where a number is a founder-set mark rather than a market
price, it says so. An APY we cannot pay is a rug with extra steps; nothing below
is advertised that the funded pool cannot cover.

---

## 0. Chain facts the design rests on

| Fact | Value | Source |
|---|---|---|
| Chain ID | 3961 | brief |
| Block time (target) | 7.2 s → **4,380,000 blocks/yr** | 31,536,000 / 7.2 |
| Current height | ~11,800 | brief (2026-08-20) |
| Block reward | 6 FMX now; **1 FMX from block 20,000** (Emission fork); halving every 4,500,000 blocks | brief |
| PoS transition | hooks-only, planned at **block 4,500,000** | brief |
| Time to PoS fork | (4,500,000 − 11,800) × 7.2 s = 32,315,040 s ≈ **374 days ≈ 12.3 months** | arithmetic |
| EVM | Paris (geth v1.10.26 fork) — **no PUSH0** | brief + foundry.toml |
| Compiler | solc 0.8.24 pinned, `evm_version = "paris"` | contracts/foundry.toml |
| Owner of everything | MinimalMultisig 2-of-3 `0x910B…fEfe` | brief |

### Supply arithmetic

Premine (founder-held keys, offline):

| Wallet | FMX |
|---|---:|
| Treasury `0xc0A5…15aB` | 12,000,000 |
| Ecosystem `0xEeDd…1E787` | 6,000,000 |
| AZNT-ops `0x040F…D0AE` | 4,000,000 |
| Community `0x34f5…65fC` | ~2,970,000 |
| Team (FMXVesting `0x6F48…430B`) | 5,000,000 |
| **Premine total** | **~29,970,000** |

PoW emission:

- Mined so far: ~11,800 × 6 = **~70,800 FMX**
- Remaining to Emission fork: (20,000 − 11,800) × 6 = 49,200 FMX
- Emission fork → PoS fork: (4,500,000 − 20,000) × 1 = 4,480,000 FMX
- **Total PoW-era emission ≈ 4.60M FMX**
- **Supply at the PoS fork ≈ 34.6M FMX** (29.97M premine + 4.6M mined; team
  vesting may still be partially locked)

Honesty note on "100M FMX": with 1 FMX/block halving every 4.5M blocks, total
future emission converges to ≈ 9.1M FMX. Terminal supply from the current rules
is ≈ **39.1M FMX**, not 100M. The 100M/$0.52 figure is an internal mark, not a
market-discovered price, and USD figures below are notional only. **We quote all
yields in FMX terms and never promise USD returns.**

Honesty note on distribution: the ~715 MH/s currently mining is six founder
GPUs, so today even the mined supply is largely founder-held. Third-party float
is faucet dust. Every participation target in §7 depends on the distribution
program in §7.1 actually happening — without it, this system is the founder
staking founder coins against a founder-funded pool, which achieves nothing.

---

## 1. Reward funding — where the FMX actually comes from

### Options considered

1. **Block rewards** — impossible pre-PoS; miners get them by consensus rule.
2. **TokenFactory launch fees** — currently **burned**. Recommendation: **keep
   the burn.** (a) The burn is a public commitment; reversing it costs
   credibility. (b) Revenue is unknown and almost certainly negligible against a
   seven-figure FMX reward budget — redirecting it changes nothing material.
   Revisit at PoS, when fee-routing to validators is standard practice.
   *Flagged as a decision point; default is no change.*
3. **A prefunded pool from the ecosystem allocation** — the only real source.
   **Chosen.**
4. **Nothing until PoS** — safest, but forfeits the entire goal (a validator
   set with a year of track record). Rejected.

### The pool

- **Initial pool: 1,500,000 FMX** — 25% of the 6M ecosystem allocation —
  transferred once from the ecosystem wallet into the StakingVault via the
  multisig. The contract pays rewards **only from its actual balance**
  (fail-closed: if the pool is empty, accrual stops; no IOUs, no minting).
- **Maximum drip: 1,200,000 FMX/yr** (0.038052 FMX/s ≈ 0.274 FMX/block),
  enforced in-contract. This is the *budget*; the APY caps below are the
  *price*; whichever binds, binds.

### Runway model

Annual outlay = min(drip cap, Σ tier-cap APY × staked per tier). Runway =
pool ÷ outlay.

| Scenario | Staked (mix) | Outlay/yr | Runway on 1.5M |
|---|---|---:|---:|
| Cold start | 0.5M, mostly flexible | ~55k | decades (moot) |
| **Target** | 5M (2M flex, 1.5M 90d, 0.5M 180d, 1M validator) | **825k** | **21.8 months** |
| Hot | ≥12M weighted units → drip cap binds | 1,200k | **15.0 months (hard floor)** |

The hard floor (15 months) exceeds the 12.3-month path to the PoS fork with
~2.7 months of margin. **If the fork slips more than ~3 months at full drip,
the multisig must top up** (each further month at full drip costs 100k FMX;
the ecosystem wallet retains 4.5M). This is stated up front, not discovered
later.

**What the ecosystem allocation can actually sustain for 12 months:** total
outlay ≤ 1.5M FMX. On the 5M-FMX target stake that is a **blended ~16.5% APY
(825k/yr) by design, ~30% at the absolute limit**. Anything advertised above
the per-tier caps in §3 is unpayable and is therefore not offered.

### What happens when the pool runs out

Accrual stops (fail-closed) — stakers keep principal and already-accrued
rewards, and the app shows pool balance + projected depletion date at all
times. But the pool is designed as a **bridge, not a perpetuity**: at block
4,500,000 the block reward (0.5 FMX after the coincident halving) is redirected
to stakers by consensus rule (§5), i.e. **2.19M FMX/yr of protocol emission
replaces the pool**. The pool only has to survive until the fork, and it does,
with margin.

---

## 2. What staking buys the chain today — plainly

Staked FMX **does not secure this chain**. When this was written, security came from
hashrate; since block 160,000 it comes from the authorised signer set. Either way,
locking coins adds zero consensus security, and we will not imply otherwise in
any copy. What the program actually buys:

1. **A validator set that exists before it is needed.** Operators with 12
   months of bonded stake, registered consensus keys, and measured uptime,
   ready to be read by the PoS client at the fork. This is the entire point.
2. **Supply sink.** Locked FMX is FMX not sold; on a thin float this is the
   dominant price-relevant effect. It is a market effect, not security.
3. **Operator identification.** A year of uptime history separates people who
   can run infrastructure from people who filled in a form.
4. **Real (non-consensus) network utility.** Additional full nodes do help:
   block/tx propagation, RPC capacity, chain-data redundancy, and
   eclipse-resistance for light clients. Useful — but it is *service*, not
   *security*, and the copy must say "support the network", never "secure the
   network" until PoS.

---

## 3. Tiers, locks, cooldowns, exits

All rewards are **stake-proportional** via weighted units (see §4 for why this
is the Sybil defence, not just a pricing table). Weight × 10%/yr = tier APY
cap.

| Tier | Lock | Weight | APY cap | Notes |
|---|---|---:|---:|---|
| Flexible | none | 1.0× | 10% | exit any time via cooldown |
| Locked-90 | 90 days | 1.5× | 15% | |
| Locked-180 | 180 days | 2.0× | 20% | |
| **Validator-track** | to block **4,680,000** (fork + ~15 days) | **3.0×** | **30%** | ≥25,000 FMX bond + registered node; the 2.0→3.0 step is uptime-gated (§4) |

Mechanics:

- **Cooldown:** every unstake, all tiers, passes a **7-day cooldown**; no
  rewards accrue during cooldown. This prevents flash-staking around
  attestation epochs and gives the market notice of exits.
- **Early exit from a locked tier** ("emergency exit"): permitted, at a price —
  forfeit **all unclaimed rewards** plus a **5% principal penalty**, both paid
  into the reward pool, then the normal 7-day cooldown. Locks must bind or the
  weights are fake.
- **Rewards on normal exit:** claimable any time; claiming does not unstake.
- **Validator-track** requires: min **25,000 FMX** bonded per registered node,
  one node per stake position, consensus signing address + node identity
  registered (§5). Its lock intentionally spans the fork; from block
  4,500,000 the PoS unbonding rules (14 days, §5) supersede.
- **Premine wallets are excluded** from earning (treasury, ecosystem, AZNT-ops,
  community, vesting — enforced by an in-contract deny list set at deploy).
  The founder may run **clearly labelled foundation validators** whose combined
  weight is policy-capped at 30% of the validator set at the fork (§6, risk 4 —
  this cap is policy, not protocol, and is stated as such).

---

## 4. The Sybil problem — the defence and its limits

**The core design decision: there are no per-node rewards. None.** Every FMX
paid out is proportional to bonded stake. "Running a node" is not a payment
category; it is a *multiplier condition* (the 2.0×→3.0× step) on stake that is
already bonded, capped by that stake.

Why this kills the economics of Sybil:

- 200 fake nodes require 200 × 25,000 = **5,000,000 FMX bonded** (~$2.6M at the
  internal mark). Yield on those 200 positions is **identical** to one
  5M position — splitting buys zero additional reward and costs ~200 × $60/yr
  in VPS ≈ $12k/yr of pure waste. The rational "attack" collapses into
  *being a large staker*, which is just the product.
- A flat per-node payment — the thing that invites 200-VPS farms — does not
  exist anywhere in the system.

**Uptime attestation is trusted, and we say so.** Uptime cannot be proven
trustlessly on this chain: the EVM cannot observe liveness, and PoW gives no
signature slot. So:

- An off-chain **watchtower** (team-operated; oracle key rotatable by the
  multisig) issues randomized challenges — sign-this-nonce with the registered
  node key, report block hashes at random recent heights, connectivity probes
  from multiple vantage points — and posts a **signed epoch attestation**
  (merkle root of per-node uptime scores, 1-day epochs) on-chain.
- The contract trusts that root. **This is an operator-signed oracle, not a
  proof**, and the design bounds its power accordingly: the watchtower can only
  move a validator-track position between 2.0× and 3.0× (uptime ≥95% in epoch
  → 3.0×, else 2.0×). It can never touch principal, never slash, and never
  affect the other tiers. Maximum oracle influence: **one-third of one tier's
  reward stream.** Challenge logs are published; disputes get a 7-day window
  before an epoch root finalizes.

**What a determined attacker still gets away with — honestly:**

1. **Node-count inflation.** One machine can answer challenges for 50
   "nodes" behind proxies with distinct keys. Rewards: zero extra. Damage:
   vanity decentralization metrics. Mitigation: watchtower publishes IP/ASN
   diversity heuristics; we report *"bonded nodes"* and *"distinct-operator
   estimate"* separately and never claim the former is the latter.
2. **Seat capture at the fork.** A whale with 21 × 25k bonds can Sybil
   addresses to claim every validator seat; no on-chain rule can stop it
   (address-cap is trivially evaded). Mitigation is deliberately *social and
   trusted*: the **foundation delegation program** (§7.1) bonds delegated stake
   to ≥15 vetted, known-distinct operators, guaranteeing an operationally
   diverse floor in the top-21 regardless of whale behaviour. Vetting is
   KYC-lite and centralized; stated, not hidden.
3. **Watchtower operator misconduct** (censoring a node's uptime): bounded to
   the 1/3 stream above, visible in published logs, remediable by multisig key
   rotation. Trusted component, admitted.

---

## 5. The PoS migration path — concrete

Target consensus: **PoSA (clique-derived, BSC-style)** in ferminux-geth.
Rationale: v1.10.26 already ships clique (round-robin signing, epoch
checkpoints); extending clique to read its signer set from a contract is a
bounded client change, whereas a beacon-style consensus is a rewrite we cannot
land in 12 months.

### What the client reads

- `ValidatorRegistry` is deployed at a **well-known address recorded in the
  chain config**, exposing a fixed ABI:
  `getValidators() → (address[] consensusAddrs, uint256[] bonds)` — the top-21
  validator-track positions by bond that satisfy: bond ≥ 25,000 FMX,
  registered consensus (block-signing) address, uptime qualification (≥95%
  attested over the trailing 90 days at the fork).
- Registration binds three things per position: staker address → consensus
  ECDSA signing address → node identity (enode pubkey hash), with a signature
  from the node key proving control. All three are on-chain state today, which
  is what makes the fork read deterministic.

### At block 4,500,000

1. Last PoW block is 4,499,999. A **difficulty bomb is scheduled at block
   4,520,000** in the same client release, so miners cannot ignore the fork.
2. At the fork block the client makes a static EVM call (state at block
   4,499,999) to `getValidators()` and installs the result as the initial
   signer set. Because the set is a pure function of consensus state, every
   node derives the same set — no off-chain coordination file. Seat *ranking*
   is by bond; block production is **equal round-robin** among the 21 (clique
   semantics; stake-weighted proposer selection is a larger client change and
   is explicitly deferred).
3. **Set updates:** every epoch (1,200 blocks ≈ 2.4 h) the client re-reads
   `getValidators()` and rotates the set. Joining PoS = bond ≥25k in the
   registry and qualify; leaving = unbond (next point).
4. **Block reward redirection:** from the fork, the client credits the block
   reward (0.5 FMX post-halving) to a **SystemRewards contract** at a fixed
   address instead of the coinbase. The contract splits: **70% to active
   validators pro-rata bond, 20% to the non-validator staking tiers, 10% to
   treasury.** That is **2.19M FMX/yr of consensus-rule funding** replacing the
   ecosystem pool — the sustainability hand-off in §1.
5. **Locked stake at the transition:** validator-track bonds become slashable
   consensus bonds; cooldown is replaced by a **14-day unbonding queue**;
   double-sign slashing (evidence submitted to the registry, 5% of bond →
   SystemRewards) activates. Flexible/90/180 tiers are untouched — they simply
   start earning from the 20% SystemRewards share; remaining pool balance
   continues dripping until empty, then the pool is done.
6. **Weak subjectivity:** for the first phase the multisig publishes signed
   checkpoints (long-range-attack mitigation on a chain this small). Trusted,
   stated.

### What must be true BEFORE the fork (go/no-go checklist)

- [ ] PoSA client release run on a **public testnet with this exact registry
      contract for ≥90 days**, including at least one forced set-rotation and
      one slashing drill.
- [ ] **≥15 distinct vetted operators** bonded and ≥95%-attested for the
      trailing 90 days (21 seats; foundation validators ≤30% of set weight).
- [ ] Registry + vault **audited and frozen** (no parameter changes inside the
      final 30 days; validator-track entries/exits frozen from block 4,470,000
      for set predictability — announced from day one).
- [ ] SystemRewards address + split burned into the client release.
- [ ] Difficulty bomb + fork block in the release; **abort path**: if
      qualified validators < 11 at block 4,470,000, the multisig coordinates a
      postponement release (this chain's forks are founder-coordinated today;
      pretending otherwise helps no one).

---

## 6. Honest risk register

1. **Circular economics.** Rewards are FMX from a founder allocation paid to
   stakers who largely obtained FMX from the founder. No external value enters.
   The APY is real only if FMX develops a liquid market; $0.52 × 100M is an
   internal mark. Mitigation: none pretended — quoted yields are FMX-
   denominated, USD figures labelled notional.
2. **Sybil residue.** Reward-farming is closed (no per-node pay), but
   node-count optics are cheaply inflatable and PoS seats are whale-capturable;
   the distinct-operator floor rests on trusted foundation vetting (§4).
3. **Oracle trust.** Uptime attestation is operator-signed; bounded to 1/3 of
   validator-tier rewards; logs published; key multisig-rotatable.
4. **Founder capture of PoS.** With ~30M of ~34.6M supply founder-held, an
   unconstrained stake-ranked set is a private network with extra steps. The
   30%-of-set policy cap plus exclusion of premine wallets from rewards is
   **policy, not protocol** — a future founder can break it. Stated.
5. **Fork slip vs runway.** 15-month hard floor vs 12.3-month ETA = 2.7 months
   margin at full drip; each extra month costs ≤100k FMX of top-up (ecosystem
   retains 4.5M). Top-up is a planned contingency, not an emergency.
6. **Honeypot risk.** The vault will be the largest FMX holder on the chain.
   Invariants: owner (multisig) can never move staked principal — only pool
   funds and parameters (48h timelock on parameter changes); no delegatecall;
   no upgradeability; pragma ^0.8.24 / Paris / zero PUSH0 verified by
   disassembly; external audit before mainnet.
7. **Regulatory.** A founder-funded advertised APY resembles a securities
   offering in most jurisdictions (same class of risk already flagged on Bolt's
   capital-return term). Needs counsel before public marketing; nothing in this
   design mitigates it.
8. **Client engineering timeline.** Contract-read PoSA + reward redirection +
   slashing on a v1.10.26 fork is months of client work, and the 90-day
   testnet soak is on the critical path: **client work must start ~6 months
   before the fork at the latest.** The staking contracts, however, are
   independent and can ship now — which is exactly why staking-first is the
   right order.

---

## 7. Numbers — what "credible" means and what people earn

**Credible PoS launch (targets at block 4,500,000):**

- **≥15 distinct, vetted, independent operators** (stretch: 25) for 21 seats —
  in line with BSC-class PoSA launches.
- **≥6M FMX staked overall** (~17% of the ~34.6M fork-time supply), of which
  **≥2.5M in validator-track bonds** (≥100 × 25k, or fewer/larger).
- **≥95% attested uptime** across qualifying operators for the trailing 90
  days.

### 7.1 Distribution reality (how 6M staked can even exist)

Third parties hold almost nothing today. The targets require the founder
allocations to move, deliberately:

- **Foundation delegation program:** ecosystem wallet bonds up to 25k FMX
  alongside each vetted operator's own 25k (cap: 25 operators, 625k FMX —
  bonded, not spent). Operator takes a 20% commission on the delegation's
  rewards. This is how Cosmos-class chains bootstrap real operators when no
  one holds the token yet — and it is also the distinct-operator floor from §4.
- Community wallet (~2.97M): staking-linked distribution (e.g., faucet →
  stake-to-unlock, operator grants), not airdrops to nowhere.
- Mined supply (~4.6M by fork) staked by miners is the organic component.

### 7.2 Worked earnings (pre-fork, at tier caps)

- **Independent operator**, 25k own bond + 25k foundation delegation:
  25,000 × 30% = 7,500 FMX/yr + 20% × (25,000 × 30%) = 1,500 FMX/yr →
  **9,000 FMX/yr** (~$4,680 notional). Against a ~$120–240/yr VPS this is
  strongly worth running *if* FMX is worth anything — see risk 1.
- **Passive staker**, 10,000 FMX at Locked-180: **2,000 FMX/yr** (20% cap).
- **Flexible staker**, 10,000 FMX: **≤1,000 FMX/yr** (10% cap).
- If participation exceeds 12M weighted units, the 1.2M/yr drip binds and all
  APYs scale down pro-rata (e.g., at 15M units: flexible 8%, validator 24%).
  The app must show live effective APY, pool balance, and depletion date.

### 7.3 Post-fork (consensus-funded, no pool needed)

2.19M FMX/yr emission → 70% validators / 20% stakers / 10% treasury:

- Validator share 1.533M/yr on 2.5M bonded → **~61%/yr**; on 5M bonded →
  ~31%/yr (self-diluting, as it should be).
- Staker share 438k/yr on ~3.5M non-validator stake → ~12.5%/yr.
- Next halving at block 9,000,000 (~12.5 months post-fork) halves these —
  fee revenue has to grow into the gap, same as every halving chain.

---

## 8. Build plan (for the implementing agents — not built yet)

**Contracts** (`/staking/contracts`, Foundry, house style: self-contained, no
OpenZeppelin, explicit require strings, NatSpec, events on every state change,
pragma ^0.8.24, `evm_version = paris`, PUSH0-free proven by disassembly):

1. `StakingVault.sol` — tiers/weights, capped-drip accumulator
   (accRewardPerUnit with the min(drip, cap) rule), 7-day cooldown, emergency
   exit (forfeit rewards + 5% → pool), prefunded pool, fail-closed accrual,
   premine deny list, non-custodial principal invariant, 48h-timelocked params,
   owner = MinimalMultisig.
2. `ValidatorRegistry.sol` — node registration (consensusAddr, enode hash,
   possession signature), watchtower epoch roots + dispute window, fixed-ABI
   `getValidators()`, post-fork slashing hooks (inert until fork).
3. `SystemRewards.sol` — fork-time split (70/20/10); inert pre-fork.

**Off-chain:** watchtower service (challenge engine, published logs, epoch-root
signer); staking UI in wallet-web style (live effective APY, pool balance +
depletion date, every loading/empty/error state); miner-app "Run a node" flow
(key generation, registration tx, uptime status).

**Testing:** local anvil only on assigned ports; Monte-Carlo the accumulator
against the runway table in §1; disassembly gate for PUSH0 in CI.

**Client (separate track, start ≤6 months before fork):** PoSA engine,
registry read, SystemRewards redirect, difficulty bomb, testnet soak.
