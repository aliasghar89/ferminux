-- Per-block rewards for Blockscout, which cannot derive them over RPC for a
-- geth-variant chain.
--
--   validator      = protocol subsidy paid to the block's miner + priority fees
--   emission_funds = the shares the protocol pays to contracts, not to a miner
--
-- The subsidy MUST mirror the chain:
--   chain/consensus/ethash/ferminux.go:FerminuxBlockReward
--       block <  20,000  -> 6 FMX                      (launch rate)
--       block >= 20,000  -> 1 FMX >> (block / 4,500,000)
--   chain/consensus/posa (from PosaBlock = 160,000)
--       total    = that reward / 4                     (approved emission cut)
--       sink     = 50% of total   -> FMXRewardSink contract
--       treasury = 10% of total   -> treasury
--       signer   = the remainder (40% plus the integer-division remainder)
--   tips = sum(gas_used * gas_price) - base_fee * gas_used, floored at 0.
--   Transaction fees follow Engine.Author, which for an authority header is the
--   ECRECOVERED signer (core/evm.go beneficiary), so tips stay with the miner
--   row after the fork exactly as before it.
--
-- Uncle rewards are not modelled (uncles are effectively absent at ~7s blocks,
-- and the authority era has none at all).
--
-- THREE BUGS THIS FILE HAS HAD, named so they are not reintroduced:
--
--   1. The subsidy was hardcoded to 6 FMX with the pre-fork halving curve, so
--      every block after the emission fork was reported at six times what the
--      chain actually paid. On this chain the table IS the number the explorer
--      shows, so it was a six-fold public overstatement of emission on the page
--      people use to check supply.
--
--   2. It only ever INSERTed rows that did not exist, so once a wrong reward was
--      written no amount of re-running could fix it. A seeder that can only
--      write once cannot survive a consensus change, and this chain has had two.
--
--   3. The subsidy expression was duplicated between the insert and the repair,
--      which is how (1) survived a partial fix. It is now a single IMMUTABLE
--      function that both statements call, so they cannot disagree again.

BEGIN;

-- Single source of truth for the schedule. IMMUTABLE: same block, same answer,
-- always — the planner may cache it freely.
-- NOTE the div(): the era is a FLOOR of num/4,500,000, and `(num / 4500000)::int`
-- does not compute it. Numeric division keeps the fraction and the cast to int
-- ROUNDS, so block 4,499,999 would land in era 1 and be paid half its due, and
-- every block from 2,250,000 onward would be understated. The previous version
-- of this file was accidentally safe because it divided two bigints, where SQL
-- floors; introducing a numeric parameter silently changed the arithmetic. The
-- boundary test in the deploy caught it. div() truncates, which for a positive
-- block number is the floor the Go code performs.
CREATE OR REPLACE FUNCTION ferminux_subsidy_total(num numeric) RETURNS numeric AS $$
  SELECT CASE
    WHEN num < 20000 THEN 6000000000000000000::numeric
    WHEN num < 160000 THEN div(1000000000000000000::numeric, (2::numeric ^ LEAST(div(num, 4500000)::int, 63)))
    ELSE div(div(1000000000000000000::numeric, (2::numeric ^ LEAST(div(num, 4500000)::int, 63))), 4)
  END;
$$ LANGUAGE sql IMMUTABLE;

-- The signer's share: the whole subsidy before the authority fork, and after it
-- the remainder once the sink and treasury shares are taken — computed by
-- subtraction, like the engine, so the integer-division remainder lands in the
-- same place the chain puts it.
CREATE OR REPLACE FUNCTION ferminux_share_miner(num numeric) RETURNS numeric AS $$
  SELECT CASE WHEN num < 160000 THEN ferminux_subsidy_total(num)
              ELSE ferminux_subsidy_total(num)
                   - div(ferminux_subsidy_total(num) * 50, 100)
                   - div(ferminux_subsidy_total(num) * 10, 100)
         END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION ferminux_share_sink(num numeric) RETURNS numeric AS $$
  SELECT CASE WHEN num < 160000 THEN 0::numeric
              ELSE div(ferminux_subsidy_total(num) * 50, 100) END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION ferminux_share_treasury(num numeric) RETURNS numeric AS $$
  SELECT CASE WHEN num < 160000 THEN 0::numeric
              ELSE div(ferminux_subsidy_total(num) * 10, 100) END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION ferminux_tips(block_hash_in bytea) RETURNS numeric AS $$
  SELECT GREATEST(
    COALESCE((SELECT SUM(COALESCE(t.gas_used, 0) * COALESCE(t.gas_price, 0))
                FROM transactions t WHERE t.block_hash = block_hash_in), 0)
    - COALESCE((SELECT COALESCE(b.base_fee_per_gas, 0) * COALESCE(b.gas_used, 0)
                  FROM blocks b WHERE b.hash = block_hash_in), 0),
    0);
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------- validator
INSERT INTO block_rewards (address_hash, block_hash, address_type, reward, inserted_at, updated_at)
SELECT b.miner_hash, b.hash, 'validator',
       ferminux_share_miner(b.number::numeric) + ferminux_tips(b.hash),
       NOW(), NOW()
FROM blocks b
WHERE b.consensus
  AND NOT EXISTS (SELECT 1 FROM block_rewards r WHERE r.block_hash = b.hash AND r.address_type = 'validator')
ON CONFLICT DO NOTHING;

UPDATE block_rewards r
SET reward = ferminux_share_miner(b.number::numeric) + ferminux_tips(b.hash), updated_at = NOW()
FROM blocks b
WHERE r.block_hash = b.hash AND b.consensus AND r.address_type = 'validator'
  AND r.reward IS DISTINCT FROM ferminux_share_miner(b.number::numeric) + ferminux_tips(b.hash);

-- ----------------------------------------------------------- emission funds
-- From the authority fork the protocol pays 50% to the reward-sink contract and
-- 10% to the treasury. These are real emission and belong on the block, but not
-- to its miner; Blockscout's second reward type is precisely for this.
-- Before the fork these produce no rows at all, so this section is inert until
-- block 160,000 — which is the point of shipping it early.
INSERT INTO block_rewards (address_hash, block_hash, address_type, reward, inserted_at, updated_at)
SELECT decode('691E5275BF346FfFa0B30174dDBeDfCC078dd8D6', 'hex'), b.hash, 'emission_funds',
       ferminux_share_sink(b.number::numeric), NOW(), NOW()
FROM blocks b
WHERE b.consensus AND b.number >= 160000
  AND NOT EXISTS (SELECT 1 FROM block_rewards r
                   WHERE r.block_hash = b.hash AND r.address_type = 'emission_funds'
                     AND r.address_hash = decode('691E5275BF346FfFa0B30174dDBeDfCC078dd8D6', 'hex'))
ON CONFLICT DO NOTHING;

INSERT INTO block_rewards (address_hash, block_hash, address_type, reward, inserted_at, updated_at)
SELECT decode('c0A5Eb613f859f072554F29f1Ab7400265af15aB', 'hex'), b.hash, 'emission_funds',
       ferminux_share_treasury(b.number::numeric), NOW(), NOW()
FROM blocks b
WHERE b.consensus AND b.number >= 160000
  AND NOT EXISTS (SELECT 1 FROM block_rewards r
                   WHERE r.block_hash = b.hash AND r.address_type = 'emission_funds'
                     AND r.address_hash = decode('c0A5Eb613f859f072554F29f1Ab7400265af15aB', 'hex'))
ON CONFLICT DO NOTHING;

UPDATE block_rewards r
SET reward = ferminux_share_sink(b.number::numeric), updated_at = NOW()
FROM blocks b
WHERE r.block_hash = b.hash AND b.consensus AND r.address_type = 'emission_funds'
  AND r.address_hash = decode('691E5275BF346FfFa0B30174dDBeDfCC078dd8D6', 'hex')
  AND r.reward IS DISTINCT FROM ferminux_share_sink(b.number::numeric);

UPDATE block_rewards r
SET reward = ferminux_share_treasury(b.number::numeric), updated_at = NOW()
FROM blocks b
WHERE r.block_hash = b.hash AND b.consensus AND r.address_type = 'emission_funds'
  AND r.address_hash = decode('c0A5Eb613f859f072554F29f1Ab7400265af15aB', 'hex')
  AND r.reward IS DISTINCT FROM ferminux_share_treasury(b.number::numeric);

-- A pre-fork block has no emission-funds share. If one is ever written (a bad
-- backfill, a rolled-back fork block), remove it rather than leave emission
-- credited that the chain never paid.
DELETE FROM block_rewards r
USING blocks b
WHERE r.block_hash = b.hash AND r.address_type = 'emission_funds' AND b.number < 160000;

COMMIT;
