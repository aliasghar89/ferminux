# Proof bridge — transfers proven from Ferminux's own blocks

Status: **phase 1a built and tested, nothing deployed.** The live bridge is unchanged.

## Why

Today a transfer crosses because 2 of 3 relayer validators sign it, and a
multisig governs the contracts. Everything on the destination chain rests on
those keys. A proof bridge removes the validators from the transfer path: the
destination chain checks the source chain's own consensus and receipts, so a
transfer is accepted because Ferminux's signers finalised it, not because
someone vouched for it.

## How Ferminux blocks are proven on another chain

Ferminux seals one block every 7 s with one of a small signer set (5 today).
Two properties of its Clique-style consensus make it cheap to verify in a
contract:

1. **Every checkpoint header lists the whole signer set.** Checkpoints are the
   blocks divisible by 30,000 (180,000, 210,000, …). The list is inside the
   sealed header, so it is covered by the signature.
2. **A signer can seal at most one block in any run of floor(N/2)+1.**

`FerminuxLightClient` turns that into three rules:

| Rule | What it means | What it costs an attacker |
|---|---|---|
| **Final** | A block is final when it and the blocks built on it carry seals from a *majority* of that epoch's signers (3 of 5). | A majority of signer keys: the same trust the chain itself runs on. |
| **Signer sets** | Starts from one trusted checkpoint. The next set is adopted only from the *next* checkpoint, in order, once the *current* set's majority has sealed it final. There is no setter. | Rewriting who the signers are takes a majority of the current signers. Governance can't do it. |
| **Conflict** | Two different blocks at the same height, *both* final, prove a safety failure. Anyone may submit them and the client freezes itself. | Ordinary short reorgs never produce two final branches, so they can't trip it. |

`FerminuxSentVerifier` then proves a transfer. Given a finality proof for a
block, a Merkle-Patricia proof of one receipt in its `receiptsRoot`, and a log
index, it checks all of the following:

- the log was emitted by the Ferminux bridge contract (`0xe162…9EF4`),
- the log is a `Sent` event,
- the transaction succeeded,
- every field of the claimed transfer equals the log, and the fields hash to
  the logged `transferId`.

The RLP and Merkle-Patricia code is Optimism's audited MIT library, vendored
byte for byte at a pinned commit (`src/proof/vendor/README.md`).

### Trust, before and after

| | Today | With proofs (Ferminux → BNB) |
|---|---|---|
| Who authorises a mint of wFMX | 2 of 3 relayer validator keys | a majority of Ferminux's own signers (by finalising the block) |
| Can a relayer forge a transfer | yes, with 2 keys | no: relayers only carry proofs anyone can check |
| Can governance forge a transfer | by replacing validators (48 h timelock) | no. It can freeze, and swap the light client only by redeploying the bridge |
| Liveness | validators online | anyone online with an RPC (proofs are permissionless) |

## Evidence

`forge test --match-path test/proof/FerminuxProof.t.sol`: 25 tests. The full bridge suite is 381/381.

**Real mainnet data.** Fixtures come from `tools/proof/gen-fixtures.mjs`. Every
header is re-encoded and must hash to the node's block hash, and every receipt
trie is rebuilt and must equal the header's `receiptsRoot`, or the script aborts.
With that data, the light client:

- bootstraps from checkpoint 180,000 (the 5 live signers),
- advances through every real checkpoint to 360,000,
- proves real blocks 361,975 and 372,351 final,
- proves their receipts (including a transaction at index 1),
- runs a real agent-registry log through the whole verifier and refuses it as
  not a `Sent`.

**Refused on real data:**

- a tampered header,
- 2 seals of 5 (not final),
- a reordered run,
- a skipped checkpoint (180,000 → 240,000),
- a block from an epoch it hasn't adopted.

**Synthetic attacks.** A private chain in the identical format supplies what
mainnet can't. Refused or handled:

- an outsider's seal,
- two signers taking turns (never final),
- conflicting final branches, which freeze the client until the owner
  unfreezes it,
- a signer-set change adopted only on the old majority's seals.

For a proven `Sent`, each of these is refused:

- a changed amount, recipient, sender, nonce, token or chain,
- a decoy log in the same receipt,
- a reverted transaction,
- a different bridge deployment,
- a proof for the wrong transaction index,
- any proof while the client is frozen.

**Gas.** Finality over 5 real headers costs ~545k gas (BNB Chain at 0.05 gwei is
about $0.02).

## What is NOT covered yet

- **Transfers before block 180,000 can't be proven.** The 7 historical `Sent`
  events (blocks 16,560–22,271) are proof-of-work blocks. They were settled long
  ago by validators and are irrelevant to a new bridge.
- **Mid-epoch signer votes are ignored.** A signer voted in mid-epoch isn't
  counted until the next checkpoint lists it, which costs liveness, never safety.
  One voted out still counts until then, but alone never reaches a majority.
- **Checkpoints must be submitted in order,** one every ~58 hours (30,000 blocks
  × 7 s). If nobody does, the client falls behind but can always catch up later,
  since headers stay available on every full node. A keeper (below) does it
  automatically.

## Plan

**Phase 1a: done.** Light client, Sent verifier, real-data fixtures, 25 tests.

**Phase 1b: BNB Chain side takes proofs instead of signatures.**

1. `FerminuxBridge` v2 on BNB Chain, the same audited contract plus an
   `executeProven(transfer, proof)` path that calls the verifier instead of
   checking validator signatures. `processed[transferId]` stays the replay
   guard. The contract has 611 B of headroom, so the check must move behind one
   external call.
2. A *prover* in the relayer builds proofs from any Ferminux RPC and submits
   them. It's permissionless, so a user can also submit their own.
3. A *keeper* calls `advance()` after every checkpoint (~every 58 h).
4. Rehearse on two anvils at the real chain ids (3961/56), like the existing
   `*-e2e.sh` scripts.

**Migration (needs your approval; every step is timelocked 48 h).**

1. Deploy on BNB Chain:
   - the light client, bootstrapped from the latest checkpoint, with its hash
     published next to the explorer's,
   - the verifier,
   - bridge v2.
2. Queue all the actions together so they serve one 48 h window:
   - BNB bridge v1 hands wFMX's minter seat to v2 (`proposeWrapperBridge` /
     `adoptWrapper`). The live wFMX and its PancakeSwap pool are unchanged.
   - Ferminux bridge `setRemoteBridge(56, v2)`.
3. Smoke test: 1 FMX across at the existing smoke caps, then reconcile.

**Phase 2: BNB Chain → Ferminux, proven too.** A BNB Chain (Parlia) light client
on Ferminux, so unlocking FMX also stops depending on validators. BNB Chain's
validator set, fast-finality BLS votes and sub-second blocks make this a larger
job than phase 1. Until then that direction stays validator-signed. That's
acceptable because it can release at most what is locked (bounded by caps), while
the phase-1 direction (minting wFMX) is the one that could otherwise create
unbacked supply.

## Files

- `contracts/src/proof/FerminuxLightClient.sol`: consensus verification
- `contracts/src/proof/FerminuxSentVerifier.sol`: receipt and `Sent` log verification
- `contracts/src/proof/vendor/`: Optimism RLP / Merkle-Patricia (MIT, pinned)
- `contracts/test/proof/FerminuxProof.t.sol`: tests
- `contracts/test/fixtures/ferminux-proof.json`: real plus synthetic fixtures
- `tools/proof/gen-fixtures.mjs`: fixture builder (`npm i && node gen-fixtures.mjs`)
