// Checks the explorer's read slice of ValidatorHub / ValidatorHubLens (src/validators/abi.ts) and the constants
// the validators pages quote (src/validators/config.ts) against the contracts as compiled from
// agents/contracts/src/validators. A struct field added, removed or reordered changes an ABI tuple silently, so
// every fragment is compared by selector, mutability and full output type.
//
//   (cd ../../agents/contracts && forge build)     # writes out/ValidatorHub.sol, out/ValidatorHubLens.sol
//   node scripts/validators-abi.test.mjs            # needs `ethers` resolvable (npm i in explorer/web)
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Interface } from "ethers";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contracts = resolve(root, "../../agents/contracts");
const failures = [];
const fail = (msg) => failures.push(msg);

function artifact(name) {
  const p = resolve(contracts, `out/${name}.sol/${name}.json`);
  if (!existsSync(p)) {
    console.error(`${p} is missing: run \`forge build\` in agents/contracts first`);
    process.exit(2);
  }
  return new Interface(JSON.parse(readFileSync(p, "utf8")).abi);
}

/** The string fragments of `export const <name> = [ ... ] as const;` in abi.ts. */
function fragments(src, name) {
  const start = src.indexOf(`export const ${name} = [`);
  const end = src.indexOf("] as const;", start);
  if (start < 0 || end < 0) throw new Error(`abi.ts: ${name} not found`);
  return [...src.slice(start, end).matchAll(/^\s*"((?:function|event|error) [^"]+)",?\s*$/gm)].map((m) => m[1]);
}

function compare(label, ours, compiled) {
  for (const f of ours.fragments) {
    if (f.type !== "function") continue;
    const c = compiled.getFunction(f.format("sighash"));
    if (!c) { fail(`${label}.${f.format("sighash")}: no such function in the compiled contract`); continue; }
    if (c.stateMutability !== f.stateMutability) fail(`${label}.${f.name}: ${f.stateMutability} here, ${c.stateMutability} in the contract`);
    const outs = (x) => x.outputs.map((o) => o.format("sighash")).join(",");
    if (outs(c) !== outs(f)) fail(`${label}.${f.name} returns (${outs(f)}) here, (${outs(c)}) in the contract`);
    // named tuple fields are what client.ts reads, so the names must match too
    const names = (x) => x.outputs.map((o) => (o.components ?? []).map((k) => k.name).join(",")).join(";");
    if (names(c) !== names(f)) fail(`${label}.${f.name} field names (${names(f)}) differ from the contract's (${names(c)})`);
  }
  console.log(`${label}: ${ours.fragments.length} fragments checked`);
}

const abiSrc = readFileSync(resolve(root, "src/validators/abi.ts"), "utf8");
compare("ValidatorHub", new Interface(fragments(abiSrc, "VALIDATOR_HUB_ABI")), artifact("ValidatorHub"));
compare("ValidatorHubLens", new Interface(fragments(abiSrc, "VALIDATOR_HUB_LENS_ABI")), artifact("ValidatorHubLens"));

// constants quoted by the pages, against the hub's own source
const sol = readFileSync(resolve(contracts, "src/validators/ValidatorHub.sol"), "utf8");
const cfg = readFileSync(resolve(root, "src/validators/config.ts"), "utf8");
const solConst = (name) => {
  const m = sol.match(new RegExp(`constant ${name} = ([0-9_.]+)( ether)?;`));
  if (!m) throw new Error(`ValidatorHub.sol: constant ${name} not found`);
  return Number(m[1].replaceAll("_", ""));
};
const cfgConst = (name) => {
  const m = cfg.match(new RegExp(`export const ${name} = ([0-9_.]+);`));
  if (!m) throw new Error(`config.ts: ${name} not found`);
  return Number(m[1].replaceAll("_", ""));
};
const win = cfg.match(/INCLUSION_WINDOW = \{ from: (\d+), to: (\d+) \}/);
const pairs = [
  ["CHECKPOINT_INTERVAL", cfgConst("CHECKPOINT_INTERVAL"), solConst("CHECKPOINT_INTERVAL")],
  ["SEAT_DEPOSIT_FMX", cfgConst("SEAT_DEPOSIT_FMX"), solConst("SEAT_DEPOSIT")],
  ["INCLUSION_WINDOW.from", Number(win?.[1]), solConst("INCLUSION_DELAY")],
  ["INCLUSION_WINDOW.to", Number(win?.[2]), solConst("INCLUSION_END")],
  ["REWARD_PER_ATTEST_FMX", cfgConst("REWARD_PER_ATTEST_FMX"), solConst("INITIAL_REWARD_PER_ATTEST")],
  ["HALVING_BLOCK", cfgConst("HALVING_BLOCK"), solConst("HALVING_BLOCK")],
  ["MIN_ELIGIBLE_FOR_CERTIFIED", cfgConst("MIN_ELIGIBLE_FOR_CERTIFIED"), solConst("MIN_ELIGIBLE_FOR_CERT")],
  ["MIN_COUNT_FLOOR", cfgConst("MIN_COUNT_FLOOR"), solConst("MIN_CERT_ATTESTATIONS")],
  ["MAX_PARTICIPATION_WINDOW", cfgConst("MAX_PARTICIPATION_WINDOW"), solConst("MAX_PARTICIPATION_WINDOW")],
];
for (const [name, ours, theirs] of pairs) if (ours !== theirs) fail(`config.ts ${name} = ${ours}, ValidatorHub.sol says ${theirs}`);
console.log(`constants: ${pairs.length} checked`);

// Seat.status order (NONE, BONDED, EXITING, WITHDRAWN = 0..3), which SEAT_RAW_STATUS indexes
const status = ["NONE", "BONDED", "EXITING", "WITHDRAWN"].map((n) => solConst(n));
if (status.join() !== "0,1,2,3") fail(`ValidatorHub.sol seat status values are ${status}, abi.ts SEAT_RAW_STATUS assumes 0,1,2,3`);

if (failures.length) {
  console.error(`\n${failures.length} mismatch(es) between the explorer and the validator contracts:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("validators ABI and constants: in sync with agents/contracts/src/validators");
