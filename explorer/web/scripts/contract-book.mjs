// Contract book data for the Contract tab (surfaces/explorer.md §5.7): one JSON per book contract with its
// ABI, compiler settings, source files and the keccak256 of its normalised deployed bytecode (immutable
// ranges zeroed, CBOR metadata tail stripped). The Contract tab hashes eth_getCode the same way in the
// browser: equal hashes = MATCHES BUILD, and only then is the source shown.
// Hermetic: it reads the committed Foundry artifacts (`*/contracts/out`) and sources, never the network.
//   npm run book   (needs the Foundry artifacts built; they are git-ignored, so this is not part of `build`)
// Also writes codes.json (bytecode fingerprints for the contracts list) and selectors.json.
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, Interface } from "ethers";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const here = resolve(web, "src/pages/address/book"); // the output directory (its *.json are regenerated)
const repo = resolve(web, "../..");
const book = JSON.parse(readFileSync(resolve(web, "src/data/contracts.3961.json"), "utf8"));

/** Book name → [Foundry project, artifact contract name]. */
const ART = {
  AgentRegistry: ["agents/contracts", "AgentRegistry"],
  ServiceEscrow: ["agents/contracts", "ServiceEscrow"],
  "Ferminux Agents (FMXA)": ["agents/contracts", "FerminuxAgents"],
  // listed in src/data/contracts.3961.json once deployed (its address comes from agents/deployments-citizens.3961.json)
  "Ferminux Citizens (FMXC)": ["agents/contracts", "FerminuxCitizens"],
  "X402 Vault": ["agents/contracts", "X402Vault"],
  AgentAccountFactory: ["agents/contracts", "AgentAccountFactory"],
  "AgentAccount (implementation)": ["agents/contracts", "AgentAccount"],
  StreamPay: ["agents/contracts", "StreamPay"],
  ArbiterPool: ["agents/contracts", "ArbiterPool"],
  "Identity 8004": ["agents/contracts", "IdentityRegistry8004"],
  "Reputation 8004": ["agents/contracts", "ReputationRegistry8004"],
  "Validation 8004": ["agents/contracts", "ValidationRegistry8004"],
  AgentTokenFactory: ["agents/contracts", "AgentTokenFactory"],
  WFMX: ["dex/contracts", "WFMX"],
  AZNT: ["contracts", "AZNT"],
  USDF: ["contracts", "USDF"],
  "TokenFactory (v1)": ["contracts", "TokenFactory"],
  "DEX Factory": ["dex/contracts", "FerminuxFactory"],
  "DEX Router": ["dex/contracts", "FerminuxRouter"],
  LiquidityLocker: ["dex/contracts", "LiquidityLocker"],
  "FMX-LP": ["dex/contracts", "FerminuxPair"],
  Bridge: ["bridge/contracts", "FerminuxBridge"],
  Faucet: ["contracts", "Faucet"],
  FMXVesting: ["contracts", "FMXVesting"],
  "Governance multisig": ["contracts", "MinimalMultisig"],
  "Reward sink": ["contracts", "FMXRewardSink"],
};
/** Templates: contracts deployed by a factory at addresses the book doesn't list (agent tokens). */
const TEMPLATES = { agenttoken: ["agents/contracts", "AgentToken", "AgentTokenFactory"] };

function artifact(project, name, file = name) {
  const p = resolve(repo, project, "out", `${file}.sol`, `${name}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
/** Zero the immutable ranges and drop the CBOR metadata tail (its length is the last two bytes). */
export function normalise(hex, ranges) {
  const h = hex.replace(/^0x/, "").toLowerCase().split("");
  for (const [start, len] of ranges) for (let i = start * 2; i < (start + len) * 2 && i < h.length; i++) h[i] = "0";
  const s = h.join("");
  const n = parseInt(s.slice(-4), 16);
  const cut = s.length - (n + 2) * 2;
  return "0x" + (Number.isFinite(n) && cut > 0 ? s.slice(0, cut) : s);
}
function entry(project, name, file, extra) {
  const a = artifact(project, name, file);
  if (!a) return null;
  const meta = typeof a.metadata === "string" ? JSON.parse(a.metadata) : a.metadata;
  const ranges = Object.values(a.deployedBytecode.immutableReferences ?? {}).flat().map((r) => [r.start, r.length]).sort((x, y) => x[0] - y[0]);
  const obj = a.deployedBytecode.object;
  const sources = {};
  for (const path of Object.keys(meta.sources)) {
    const f = resolve(repo, project, path);
    if (existsSync(f)) sources[path] = readFileSync(f, "utf8");
  }
  return {
    ...extra,
    contract: name,
    project,
    compiler: { solc: meta.compiler.version, optimizer: !!meta.settings.optimizer?.enabled, runs: meta.settings.optimizer?.runs ?? null, evm: meta.settings.evmVersion ?? null },
    abi: a.abi,
    code: { keccak: keccak256(normalise(obj, ranges)), bytes: (obj.length - 2) / 2, immutables: ranges },
    sources,
  };
}

for (const f of readdirSync(here)) if (f.endsWith(".json")) unlinkSync(resolve(here, f));
let n = 0;
const codes = {};
/** selectors.json: 4-byte selector → function name and topic0 → event name over every book ABI, so tables
 *  can name a method without loading ethers or a contract's full JSON. */
const fn = {}, ev = {};
const learn = (abi) => {
  const i = new Interface(abi);
  i.forEachFunction((f) => { if (!f.constant) fn[f.selector] ??= f.name; }); // transactions only call state-changing functions
  i.forEachEvent((e) => { ev[e.topicHash] ??= e.name; });
};
for (const c of [...book.contracts, ...book.accounts]) {
  const spec = ART[c.name];
  if (!spec) continue;
  const e = entry(spec[0], spec[1], spec[1], { name: c.name, address: c.address });
  if (!e) { console.warn(`no artifact for ${c.name}`); continue; }
  writeFileSync(resolve(here, `${c.address.toLowerCase()}.json`), JSON.stringify(e));
  codes[c.address.toLowerCase()] = { name: e.name, keccak: e.code.keccak, bytes: e.code.bytes, immutables: e.code.immutables };
  learn(e.abi);
  n++;
}
for (const [key, [project, name, file]] of Object.entries(TEMPLATES)) {
  const e = entry(project, name, file, { name, template: true });
  if (e) { writeFileSync(resolve(here, `tpl-${key}.json`), JSON.stringify(e)); learn(e.abi); n++; }
}
writeFileSync(resolve(here, "selectors.json"), JSON.stringify({ fn, ev }));
// codes.json: only the bytecode fingerprints, so a list page can say "Matches build" without loading a whole book entry
writeFileSync(resolve(here, "codes.json"), JSON.stringify(codes));
console.log(`contract book: ${n} files in ${here}`);
