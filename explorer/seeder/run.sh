#!/bin/sh
# Ferminux rewards sidecar: loops forever, seeding Blockscout's reward tables.
# Blockscout's geth variant cannot fetch PoW beneficiaries over RPC, so the
# explorer would otherwise show no miner rewards. Writes ONLY to the explorer DB.
set -u

INTERVAL="${SEED_INTERVAL_SECONDS:-20}"

echo "rewards-sidecar: seeding every ${INTERVAL}s (db=${PGHOST}:${PGPORT:-5432}/${PGDATABASE})"

while true; do
  # emission_rewards is static (halving schedule); seed once, ignore errors
  # until backend migrations have created the tables.
  # ON_ERROR_STOP=1 and stderr KEPT. The previous form used ON_ERROR_STOP=0 with
  # 2>/dev/null, which cannot fail: psql exits 0 after a syntax error, a
  # permission error or a missing column, and the discarded stderr was the only
  # place that said so. This seeder is the sole source of the reward numbers the
  # explorer publishes, so "silently wrote nothing" is the worst available
  # behaviour. Errors are now printed once per pass; the loop still continues,
  # because the tables genuinely do not exist until the backend has migrated.
  for f in emission-ranges seed-rewards; do
    if ! err=$(psql -q -v ON_ERROR_STOP=1 -f "/seeder/$f.sql" 2>&1); then
      echo "rewards-sidecar: $f.sql FAILED: $(printf '%s' "$err" | tr '\n' ' ' | cut -c1-300)"
    fi
  done
  # Authority blocks carry a zero coinbase (Clique uses that field for votes),
  # so from PosaBlock onward the explorer would credit every block to
  # 0x0000…0000 unless the sealer is recovered from the header. Inert before
  # the fork: no block matches, and it costs one indexed query per pass.
  sh /seeder/seed-signers.sh 2>&1 | grep -v '^$' || true
  sleep "$INTERVAL"
done
