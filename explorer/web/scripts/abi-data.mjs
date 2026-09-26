// Generates src/enrich/abi.data.ts: the compact ABI tables the decode chunk reads (surfaces/explorer.md §6.4).
// Run from explorer/web:  npm run book  (after scripts/contract-book.mjs; both read the same Foundry artifacts)
// Sources (read-only, committed build artefacts in this repo):
//   agents/contracts/abi/*.json                 the agent network (the same files agents/web copies)
//   dex/contracts/out/*, bridge/contracts/out/*, contracts/out/*   DEX, bridge, faucet, vesting, multisig, tokens
// Only what decoding needs is kept: state-changing functions, events and custom errors, with selectors and
// topic hashes computed here, so the browser chunk needs no keccak and no ABI parser. Views are dropped.
import { Interface } from "ethers";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const here = resolve(web, "src/enrich"); // writes src/enrich/abi.data.ts
const repo = resolve(web, "../..");
const agents = (n) => JSON.parse(readFileSync(resolve(repo, "agents/contracts/abi", n + ".json"), "utf8"));
const out = (p) => JSON.parse(readFileSync(resolve(repo, p), "utf8")).abi;

const SOURCES = {
  AgentRegistry: agents("AgentRegistry"),
  ServiceEscrow: agents("ServiceEscrow"),
  FerminuxAgents: agents("FerminuxAgents"),
  FerminuxCitizens: agents("FerminuxCitizens"),
  X402Vault: agents("X402Vault"),
  AgentAccount: agents("AgentAccount"),
  AgentAccountFactory: agents("AgentAccountFactory"),
  StreamPay: agents("StreamPay"),
  ArbiterPool: agents("ArbiterPool"),
  IdentityRegistry8004: agents("IdentityRegistry8004"),
  ReputationRegistry8004: agents("ReputationRegistry8004"),
  ValidationRegistry8004: agents("ValidationRegistry8004"),
  AgentTokenFactory: agents("AgentTokenFactory"),
  AgentToken: agents("AgentToken"),
  WFMX: out("dex/contracts/out/WFMX.sol/WFMX.json"),
  DexRouter: out("dex/contracts/out/FerminuxRouter.sol/FerminuxRouter.json"),
  DexFactory: out("dex/contracts/out/FerminuxFactory.sol/FerminuxFactory.json"),
  DexPair: out("dex/contracts/out/FerminuxPair.sol/FerminuxPair.json"),
  LiquidityLocker: out("dex/contracts/out/LiquidityLocker.sol/LiquidityLocker.json"),
  Bridge: out("bridge/contracts/out/FerminuxBridge.sol/FerminuxBridge.json"),
  Faucet: out("contracts/out/Faucet.sol/Faucet.json"),
  FMXVesting: out("contracts/out/FMXVesting.sol/FMXVesting.json"),
  Multisig: out("contracts/out/MinimalMultisig.sol/MinimalMultisig.json"),
  TokenFactory: out("contracts/out/TokenFactory.sol/TokenFactory.json"),
  FerminuxToken: out("contracts/out/TokenFactory.sol/FerminuxToken.json"),
  AZNT: out("contracts/out/AZNT.sol/AZNT.json"),
  USDF: out("contracts/out/USDF.sol/USDF.json"),
};

// The generic set for contracts outside the book: FRC-20 / FRC-721 transfers and approvals, WFMX, DEX pair.
const GENERIC = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
  "event Deposit(address indexed dst, uint256 wad)",
  "event Withdrawal(address indexed src, uint256 wad)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "function transfer(address to, uint256 value)",
  "function approve(address spender, uint256 value)",
  "function transferFrom(address from, address to, uint256 value)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
  "function setApprovalForAll(address operator, bool approved)",
  "function deposit()",
  "function withdraw(uint256 wad)",
  "error Error(string message)",
  "error Panic(uint256 code)",
];

const param = (p) => {
  const o = { n: p.name || "", t: p.baseType === "tuple" ? "tuple" : p.baseType === "array" ? arrType(p) : p.type };
  if (p.indexed) o.i = 1;
  const comps = p.baseType === "tuple" ? p.components : p.baseType === "array" ? innermost(p).components : null;
  if (comps) o.c = comps.map(param);
  return o;
};
const innermost = (p) => { let q = p; while (q.baseType === "array") q = q.arrayChildren; return q; };
const arrType = (p) => { const inner = innermost(p); return (inner.baseType === "tuple" ? "tuple" : inner.type) + p.type.slice(p.type.indexOf("[", inner.baseType === "tuple" ? p.type.lastIndexOf(")") : 0)); };

function table(abi) {
  const i = new Interface(abi);
  const t = { f: {}, e: {}, x: {} };
  i.forEachFunction((f) => { if (f.stateMutability !== "view" && f.stateMutability !== "pure") t.f[f.selector] = { n: f.name, p: f.inputs.map(param) }; });
  i.forEachEvent((e) => { (t.e[e.topicHash] ??= []).push({ n: e.name, p: e.inputs.map(param) }); });
  i.forEachError((e) => { t.x[e.selector] = { n: e.name, p: e.inputs.map(param) }; });
  return t;
}

const ABIS = Object.fromEntries(Object.entries(SOURCES).map(([k, abi]) => [k, table(abi)]));
ABIS.Generic = table(GENERIC);

const body = JSON.stringify(ABIS);
const src = `/* GENERATED by scripts/abi-data.mjs from the repo's compiled ABIs. Do not edit; re-run the script.
   Per contract: f = state-changing functions by selector, e = events by topic0 (candidates), x = custom errors.
   Params: n name, t type ("tuple" / "tuple[]" carry c = components), i = indexed. */
export interface AbiParam { n: string; t: string; i?: 1; c?: AbiParam[] }
export interface AbiFrag { n: string; p: AbiParam[] }
export interface AbiTable { f: Record<string, AbiFrag>; e: Record<string, AbiFrag[]>; x: Record<string, AbiFrag> }
export type AbiName = ${Object.keys(ABIS).map((k) => JSON.stringify(k)).join(" | ")};
export const ABIS: Record<AbiName, AbiTable> = ${body};
`;
writeFileSync(resolve(here, "abi.data.ts"), src);
console.log(`abi.data.ts: ${Object.keys(ABIS).length} tables, ${(src.length / 1024).toFixed(1)} KB`);
