#!/bin/sh
# Attribute authority blocks to the signer that actually sealed them.
#
# THE PROBLEM, which only appears at the fork and would appear on every block:
# Clique's Prepare sets header.Coinbase to the zero address (it repurposes that
# field for signer votes), and geth's RPC marshals "miner" straight from
# header.Coinbase. Blockscout believes it. So from PosaBlock onward the explorer
# would show EVERY block mined by 0x0000…0000, with the reward paid there, while
# the chain credits the ecrecovered signer — and during a signer vote it would
# name the vote's subject as the miner, which is worse than a blank.
#
# The chain is right and the explorer is wrong, so this repairs the explorer:
# for each post-fork block still attributed to the zero address, ask the node
# who sealed it (clique_getSigner recovers it from the header seal — the same
# source the consensus rules use) and rewrite blocks.miner_hash, carrying the
# reward row with it.
#
# Runs every pass and is a no-op before the fork: no block below PosaBlock
# matches, so this file changes nothing until the day it is needed. That is
# deliberate — it is deployed early precisely so fork day is not the first time
# it runs.
#
# Uses wget and psql only: the sidecar is a postgres:alpine image with no curl
# and no jq, and adding a dependency to the explorer for this would be silly.
set -u

RPC="${FMX_RPC:-http://miner:8545}"
FORK="${FMX_POSA_BLOCK:-160000}"
BATCH="${FMX_SIGNER_BATCH:-500}"
ZERO='\x0000000000000000000000000000000000000000'

# Blocks past the fork that are still credited to nobody. Ordered oldest first
# so a long backlog converges from the fork forward rather than in random order.
rows=$(psql -tAF'|' -c "
  SELECT number, '0x' || encode(hash, 'hex')
  FROM blocks
  WHERE consensus AND number >= ${FORK} AND miner_hash = '${ZERO}'::bytea
  ORDER BY number
  LIMIT ${BATCH};" 2>/dev/null) || exit 0
[ -n "$rows" ] || exit 0

fixed=0
echo "$rows" | while IFS='|' read -r number hash; do
  [ -n "$hash" ] || continue
  signer=$(wget -qO- --timeout=8 \
    --header='Content-Type: application/json' \
    --post-data="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"clique_getSigner\",\"params\":[\"${hash}\"]}" \
    "$RPC" 2>/dev/null | sed -n 's/.*"result":"0x\([0-9a-fA-F]\{40\}\)".*/\1/p')
  # No signer means the node could not recover one. Leave the row alone: a wrong
  # attribution is worse than a missing one, and the next pass will retry.
  [ -n "$signer" ] || { echo "seed-signers: block ${number}: no signer from ${RPC}"; continue; }

  psql -q -v ON_ERROR_STOP=1 <<SQL 2>/dev/null || { echo "seed-signers: block ${number}: update failed"; continue; }
BEGIN;
-- blocks.miner_hash references addresses.hash, so the signer must exist there
-- first. Blockscout fills the rest of the row on its own once it indexes the
-- address; all that matters here is that the foreign key resolves.
INSERT INTO addresses (hash, inserted_at, updated_at)
VALUES (decode('${signer}', 'hex'), NOW(), NOW())
ON CONFLICT (hash) DO NOTHING;

UPDATE blocks
   SET miner_hash = decode('${signer}', 'hex'), updated_at = NOW()
 WHERE number = ${number} AND consensus AND miner_hash = '${ZERO}'::bytea;

-- Carry the reward row to the same address. The PRIMARY KEY is
-- (address_hash, block_hash, address_type), so this is an update of the key
-- itself; if a row for the correct address somehow already exists, keep it and
-- drop the stale zero-address one rather than failing the batch.
UPDATE block_rewards r
   SET address_hash = decode('${signer}', 'hex'), updated_at = NOW()
  FROM blocks b
 WHERE b.number = ${number} AND r.block_hash = b.hash
   AND r.address_type = 'validator'
   AND r.address_hash = '${ZERO}'::bytea
   AND NOT EXISTS (
     SELECT 1 FROM block_rewards r2
      WHERE r2.block_hash = r.block_hash AND r2.address_type = r.address_type
        AND r2.address_hash = decode('${signer}', 'hex'));

DELETE FROM block_rewards r
 USING blocks b
 WHERE b.number = ${number} AND r.block_hash = b.hash
   AND r.address_type = 'validator'
   AND r.address_hash = '${ZERO}'::bytea;
COMMIT;
SQL
  fixed=$((fixed + 1))
done

# The loop runs in a subshell (pipe), so report from a fresh count rather than
# from $fixed, which would always read 0 out here.
remaining=$(psql -tAc "SELECT count(*) FROM blocks WHERE consensus AND number >= ${FORK} AND miner_hash = '${ZERO}'::bytea;" 2>/dev/null)
[ "${remaining:-0}" = "0" ] || echo "seed-signers: ${remaining} authority block(s) still unattributed"
