-- Ferminux emission schedule -> Blockscout emission_rewards table.
--
-- MUST mirror chain/consensus/ethash/ferminux.go:FerminuxBlockReward exactly:
--
--     if block <  20,000                -> 6 FMX          (launch rate)
--     else  era = block / 4,500,000
--           reward = 1 FMX >> era       (base rate, halving each era)
--           era >= 60 -> 0              (1e18 >> 60 == 0)
--
-- and, from the authority fork at block 160,000, the engine in
-- chain/consensus/posa quarters that reward and splits it 40/50/10 between the
-- sealing signer, the reward sink and the treasury. What this table holds is
-- the MINER'S share, because that is what Blockscout attributes to the block's
-- miner; the sink and treasury appear separately as 'emission_funds'.
--
-- The earlier version of this file predated the emission fork and encoded the
-- pre-fork schedule (6 FMX >> era from genesis). That made the explorer report
-- 6 FMX for every block after 20,000 while the chain was actually paying 1 —
-- a six-fold public overstatement of emission, on the page people would use to
-- check supply. Blockscout derives miner rewards purely from this table for a
-- geth-variant PoW chain, so a wrong row here is not cosmetic: it is the number.
--
-- Ranges must partition [0, ∞) with no gap and no overlap, so era 0 is split at
-- the fork block rather than starting at zero.
--
-- Idempotent AND self-correcting: unlike the previous version, this replaces the
-- contents rather than skipping when rows already exist. A schedule that can
-- only ever be written once cannot be fixed after a fork.

BEGIN;

-- Only rewrite when the table does not already match, so the 20s seeder loop is
-- not churning the table on every pass.
CREATE TEMP TABLE want_emission (block_range int8range, reward numeric) ON COMMIT DROP;

-- Launch rate, genesis up to the emission fork.
INSERT INTO want_emission VALUES (int8range(0, 20000), 6000000000000000000::numeric);

-- Era 0 begins at the emission fork rather than at genesis, so the first
-- base-rate range is the remainder of era 0, split again at the AUTHORITY fork.
INSERT INTO want_emission VALUES (int8range(20000, 160000), 1000000000000000000::numeric);

-- From the authority fork (PosaBlock 160,000) the reward is the proof-of-work
-- schedule divided by four and then split three ways by the engine
-- (consensus/posa: 50% reward sink, 10% treasury, the remainder to the signer).
-- This table drives what the explorer shows as the reward for the block's
-- miner, and the block's miner is the signer, so the value here is the SIGNER'S
-- share: 1 FMX / 4 = 0.25, minus 50% and 10%, = 0.1 FMX. The other 0.15 is
-- written as an 'emission_funds' row by seed-rewards.sql, which is exactly the
-- distinction Blockscout's two reward types exist to express.
INSERT INTO want_emission VALUES (int8range(160000, 4500000), 100000000000000000::numeric);

-- Eras 1..59. div() floors, which reproduces the Go right-shift exactly.
-- Era 59 still pays 1 wei; era 60 floors to 0, which is why the tail starts there.
-- Eras 1..59 are entirely inside the authority era, so each carries the
-- signer's share of the quartered subsidy.
--
-- Computed as the REMAINDER after the sink and treasury take their cuts, not as
-- a flat 40%. The engine (consensus/posa SplitReward) does
--     signer = total - (total*50/100) - (total*10/100)
-- with integer division, so the truncation remainder lands with the signer. A
-- flat 40% throws that remainder away and understates the signer by 1-2 wei
-- from era 16 onward — the two forms agree for the first sixteen eras, which is
-- exactly why the discrepancy would never have shown up in testing and would
-- have quietly appeared around year sixteen. Match the engine, not the
-- description of the engine.
INSERT INTO want_emission
SELECT int8range(era * 4500000, (era + 1) * 4500000),
       t - div(t * 50, 100) - div(t * 10, 100)
FROM (SELECT era, div(div(1000000000000000000::numeric, (2::numeric ^ era)), 4) AS t
        FROM generate_series(1, 59) AS era) q;

-- Fully decayed from era 60 (block 270,000,000) onward.
INSERT INTO want_emission VALUES (int8range(270000000, NULL), 0::numeric);

-- Replace only if different, so the loop is a no-op once correct.
DELETE FROM emission_rewards
WHERE NOT EXISTS (
  SELECT 1 FROM want_emission w
  WHERE w.block_range = emission_rewards.block_range AND w.reward = emission_rewards.reward
);

INSERT INTO emission_rewards (block_range, reward)
SELECT w.block_range, w.reward FROM want_emission w
WHERE NOT EXISTS (
  SELECT 1 FROM emission_rewards e
  WHERE e.block_range = w.block_range AND e.reward = w.reward
);

COMMIT;
