#!/usr/bin/env bash
# Every machine's slashing-protection database against the chain: each record's hash must be
# the canonical block hash at that height, no height may carry two hashes for one key, and every
# attestation the hub accepted must be in the protection database of the machine that signed it.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); export HERE
. "$HERE/lib.sh"
TMP=$(mktemp)
for c in $(docker ps --format '{{.Names}}' | grep -E '^fmxd-(v[0-9]+|h[0-9]+)$' | sort); do
  m=${c#fmxd-}
  case $m in
    h*) for d in $(docker exec "$c" sh -c 'ls -d /var/lib/fmx-validator/s*'); do
          docker exec "$c" sh -c "cat $d/devnet/protection.log 2>/dev/null" | awk -v m="$m/${d##*/}" '$1=="A1"{print m, $4, $5, $6}' >> "$TMP"
        done ;;
    *) docker exec "$c" sh -c 'cat /var/lib/fmx-validator/devnet/protection.log 2>/dev/null' | awk -v m="$m" '$1=="A1"{print m, $4, $5, $6}' >> "$TMP" ;;
  esac
done
node - "$TMP" <<'EOF'
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const HERE = process.env.HERE;
const req = createRequire(path.join(HERE, "../../explorer/web/package.json"));
const { ethers } = req("ethers");
const dep = JSON.parse(fs.readFileSync(path.join(HERE, ".run/deployments.json"), "utf8"));
const abi = JSON.parse(fs.readFileSync(path.join(HERE, "../../agents/contracts/out/ValidatorHub.sol/ValidatorHub.json"), "utf8")).abi;
const p = new ethers.JsonRpcProvider(process.env.RPC || "http://127.0.0.1:39545");
const hub = new ethers.Contract(dep.validatorHub, abi, p);
(async () => {
  const recs = fs.readFileSync(process.argv[2], "utf8").trim().split("\n").filter(Boolean).map((l) => {
    const [m, att, h, hash] = l.split(" ");
    return { m, att: att.toLowerCase(), h: Number(h), hash: hash.toLowerCase() };
  });
  const byKey = new Map();
  let conflicts = 0, wrongHash = 0;
  const hashAt = new Map();
  for (const r of recs) {
    const k = `${r.att}:${r.h}`;
    if (byKey.has(k) && byKey.get(k).hash !== r.hash) conflicts++;
    byKey.set(k, r);
    if (!hashAt.has(r.h)) hashAt.set(r.h, (await p.getBlock(r.h)).hash.toLowerCase());
    if (hashAt.get(r.h) !== r.hash) wrongHash++;
  }
  // accepted attestations on-chain
  const head = await p.getBlockNumber();
  const logs = [];
  for (let a = 0; a <= head; a += 5000) logs.push(...(await p.getLogs({ address: dep.validatorHub, fromBlock: a, toBlock: Math.min(head, a + 4999), topics: [hub.interface.getEvent("Attested").topicHash] })));
  let missing = 0;
  const seatAtt = new Map();
  for (const l of logs) {
    const ev = hub.interface.parseLog(l);
    const seat = Number(ev.args.seatId), h = Number(ev.args.height);
    const tx = await p.getTransaction(l.transactionHash);
    let signer = null;
    try {
      const d = hub.interface.decodeFunctionData("attest", tx.data);
      const digest = await hub.attestationDigest(d[0], d[1]);
      signer = ethers.recoverAddress(digest, d[2]).toLowerCase();
    } catch { signer = null; }
    if (!signer || !byKey.has(`${signer}:${h}`)) missing++;
    seatAtt.set(seat, (seatAtt.get(seat) || 0) + 1);
  }
  const perMachine = {};
  for (const r of recs) perMachine[r.m] = (perMachine[r.m] || 0) + 1;
  console.log(JSON.stringify({ head, machines: Object.keys(perMachine).length, records: recs.length, recordsPerMachine: perMachine,
    conflictingRecords: conflicts, recordsNotCanonical: wrongHash, acceptedAttestations: logs.length,
    acceptedWithoutLocalRecord: missing }, null, 1));
  console.log(conflicts === 0 && wrongHash === 0 && missing === 0 ? "  ok: every signature on record is the canonical hash, once per height, and every accepted attestation is on record"
    : "  FAIL: see counts above");
})();
EOF
rm -f "$TMP"
