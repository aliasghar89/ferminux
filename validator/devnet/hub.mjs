// Read-only views of the devnet ValidatorHub for the evidence logs (ethers v6 from the explorer's
// node_modules, ABIs from the forge build of agents/contracts). Never sends a transaction.
//   node hub.mjs seats | seat <id> | cp <height> | cps <from> <to> | acct | slash <id>
//                | attestations [fromBlock] | events <fromBlock> [toBlock] | window
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const require = createRequire(join(REPO, "explorer/web/package.json"));
const { ethers } = require("ethers");

const art = (n) => JSON.parse(readFileSync(join(REPO, `agents/contracts/out/${n}.sol/${n}.json`), "utf8")).abi;
const dep = JSON.parse(readFileSync(join(HERE, ".run/deployments.json"), "utf8"));
const provider = new ethers.JsonRpcProvider(process.env.RPC || "http://127.0.0.1:39545", undefined, { batchMaxCount: 50 });
const hub = new ethers.Contract(dep.validatorHub, art("ValidatorHub"), provider);
const lens = new ethers.Contract(dep.validatorHubLens, art("ValidatorHubLens"), provider);

const labels = {};
try {
  for (const l of readFileSync(join(HERE, ".run/labels.txt"), "utf8").split("\n")) {
    const [a, n] = l.trim().split(/\s+/);
    if (a && n) labels[a.toLowerCase()] = n;
  }
} catch {}
const lab = (a) => (labels[String(a).toLowerCase()] ? `${labels[String(a).toLowerCase()]}` : a);
const F = (w) => ethers.formatEther(w);
const STATUS = ["NONE", "BONDED", "EXITING", "WITHDRAWN"];
const SLASH = ["NONE", "PENDING", "EXECUTED", "VETOED"];
const out = (o) => console.log(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1));

async function seat(id, head) {
  const s = await lens.seat(id);
  const act = Number(s.activationBlock);
  let state = STATUS[Number(s.status)];
  if (state === "BONDED") state = s.jailed ? "JAILED" : head < act ? "PENDING" : "ACTIVE";
  return {
    id, state, owner: lab(s.owner), attester: lab(s.attester), deposit: F(s.deposit), claimable: F(s.claimable),
    activationBlock: act, eligibleFrom: act + 86400, countedSince: Number(s.countedSince),
    lastAttestedHeight: Number(s.lastAttestedCp) * 200, dutyStartCp: Number(s.dutyStartCp),
    unjailBlock: Number(s.unjailBlock), unbondEndBlock: Number(s.unbondEndBlock), slash: SLASH[Number(s.slashState)],
  };
}

async function cp(h) {
  const c = await hub.checkpoint(h);
  return { height: h, blockHash: c.blockHash, count: Number(c.count), eligible: Number(c.eligible), total: Number(c.total),
    snapshotBlock: Number(c.snapshotBlock), certified: c.certified, rule: await hub.certifies(c.count, c.eligible) };
}

async function logs(from, to) {
  const all = [];
  const step = 5000;
  for (let a = from; a <= to; a += step) {
    const b = Math.min(to, a + step - 1);
    all.push(...(await provider.getLogs({ address: dep.validatorHub, fromBlock: a, toBlock: b })));
  }
  return all.map((l) => {
    const p = hub.interface.parseLog(l);
    const args = {};
    p.fragment.inputs.forEach((inp, i) => { args[inp.name] = p.args[i]; });
    return { block: l.blockNumber, tx: l.transactionHash, event: p.name, args };
  });
}

const [cmd, a1, a2] = process.argv.slice(2);
const head = await provider.getBlockNumber();
switch (cmd) {
  case "seat": out(await seat(Number(a1), head)); break;
  case "seats": {
    const n = Number(await hub.seatCount());
    const rows = await Promise.all(Array.from({ length: n }, (_, i) => seat(i + 1, head)));
    console.log(`head ${head}  seats ${n}  occupied ${await hub.occupiedSeats()}  eligible ${await hub.eligibleCount()}  pool ${F(await hub.rewardPool())} FMX  rate ${F(await hub.currentRewardPerAttest())} FMX`);
    console.log("id  state      owner         attester      activation  eligibleFrom counted  lastAttested  claimable   deposit  unjail  unbondEnd slash");
    for (const r of rows) console.log([String(r.id).padEnd(3), r.state.padEnd(10), String(r.owner).padEnd(13), String(r.attester).padEnd(13), String(r.activationBlock).padEnd(11), String(r.eligibleFrom).padEnd(12), String(r.countedSince).padEnd(8), String(r.lastAttestedHeight).padEnd(13), r.claimable.padEnd(11), r.deposit.padEnd(8), String(r.unjailBlock).padEnd(7), String(r.unbondEndBlock).padEnd(9), r.slash].join(" "));
    break;
  }
  case "cp": out(await cp(Number(a1))); break;
  case "cps": {
    for (let h = Number(a1); h <= Number(a2); h += 200) {
      const c = await cp(h);
      console.log(`cp ${String(h).padEnd(7)} count ${String(c.count).padStart(2)} / eligible ${String(c.eligible).padStart(2)}  total ${String(c.total).padStart(2)}  certified ${c.certified}  (certifies(count,eligible) = ${c.rule})  snapshot ${c.snapshotBlock}  ${c.blockHash}`);
    }
    break;
  }
  case "acct": {
    const t = await lens.accounting();
    const bal = await provider.getBalance(dep.validatorHub);
    const pool = await hub.rewardPool();
    const bonded = await hub.bondedTotal();
    const o = {};
    for (const k of ["totalDeposited", "totalWithdrawn", "totalSlashed", "totalBurned", "pendingBurn", "totalCredits", "totalFunded", "totalAllocated", "totalClaimable", "totalClaimed", "totalReturned"]) o[k] = F(t[k]);
    o.rewardPool = F(pool); o.bondedTotal = F(bonded); o.hubBalance = F(bal);
    o.burnAddressBalance = F(await provider.getBalance("0x000000000000000000000000000000000000dEaD"));
    const checks = {
      "balance == bonded + pool + claimable + credits + pendingBurn": bal === bonded + pool + t.totalClaimable + t.totalCredits + t.pendingBurn,
      "funded == pool + claimable + claimed + returned": t.totalFunded === pool + t.totalClaimable + t.totalClaimed + t.totalReturned,
      "deposited == bonded + withdrawn + slashed": t.totalDeposited === bonded + t.totalWithdrawn + t.totalSlashed,
      "allocated <= funded": t.totalAllocated <= t.totalFunded,
      "allocated == claimable + claimed": t.totalAllocated === t.totalClaimable + t.totalClaimed,
    };
    out({ head, ...o, checks });
    break;
  }
  case "slash": {
    const s = await lens.slash(Number(a1));
    out({ slashId: Number(a1), seatId: Number(s.seatId), kind: Number(s.kind) === 1 ? "DOUBLE_ATTESTATION" : "DOUBLE_SEAL", status: SLASH[Number(s.status)],
      executableBlock: Number(s.executableBlock), vetoSunsetBlock: Number(s.vetoSunsetBlock), amount: F(s.amount), reporter: lab(s.reporter), height: Number(s.height) });
    break;
  }
  case "events": {
    const ev = await logs(Number(a1), a2 ? Number(a2) : head);
    for (const e of ev) {
      const args = Object.entries(e.args).map(([k, v]) => `${k}=${typeof v === "bigint" && v > 10n ** 15n ? F(v) : lab(v)}`).join(" ");
      console.log(`${e.block} ${e.event} ${args}`);
    }
    break;
  }
  case "window": {
    // every accepted attestation: the block that included it must be in [h+64, h+250]
    const ev = (await logs(Number(a1 || 0), head)).filter((e) => e.event === "Attested");
    let bad = 0, min = 1e9, max = 0;
    const perSeat = new Map();
    for (const e of ev) {
      const h = Number(e.args.height), d = e.block - h;
      if (d < 64 || d > 250) bad++;
      min = Math.min(min, d); max = Math.max(max, d);
      const k = `${e.args.seatId}:${h}`;
      perSeat.set(k, (perSeat.get(k) || 0) + 1);
    }
    const dup = [...perSeat.values()].filter((v) => v > 1).length;
    const paid = ev.filter((e) => e.args.reward > 0n);
    const rates = [...new Set(paid.map((e) => F(e.args.reward)))];
    out({ head, attestations: ev.length, checkpoints: new Set(ev.map((e) => Number(e.args.height))).size,
      inclusionDelay: { min, max }, outsideWindow: bad, duplicateSeatHeight: dup, paid: paid.length, unpaid: ev.length - paid.length, paidRates: rates });
    break;
  }
  case "attestations": {
    const ev = (await logs(Number(a1 || 0), head)).filter((e) => e.event === "Attested");
    for (const e of ev) console.log(`h ${e.args.height} seat ${e.args.seatId} included ${e.block} (h+${e.block - Number(e.args.height)}) reward ${F(e.args.reward)} tx ${e.tx}`);
    break;
  }
  default:
    console.error("usage: node hub.mjs seats | seat <id> | cp <h> | cps <from> <to> | acct | slash <id> | events <from> [to] | window [from] | attestations [from]");
    process.exit(2);
}
