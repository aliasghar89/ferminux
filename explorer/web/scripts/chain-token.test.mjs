// The token pages' chain fallback: a token the explorer's index hasn't catalogued yet (it lists an FRC-721 only
// after its first Transfer) is read from the chain. This checks the pieces against the live chain, read only.
//
//   node scripts/chain-token.test.mjs        # Node >= 23 (runs the .ts classifier directly); needs `ethers` (npm i)
//
// 1. The hard-coded calldata (FRC721_PROBE / FRC165_INVALID in src/rpc.ts, SEL in src/pages/tokens/common.ts) are
//    the real selectors.
// 2. classify() (src/pages/tokens/classify.ts) on live eth_call answers: FRC-721 by the FRC-165 test
//    (supportsInterface(0x80ac58cd) exactly true, supportsInterface(0xffffffff) exactly false), FRC-20 only for a
//    book token that answers decimals(), and null (the 404 stays) for everything else.
import { readFileSync } from "node:fs";
import { id } from "ethers";
import { classify } from "../src/pages/tokens/classify.ts";

const RPC = process.env.FMX_RPC || "https://rpc.ferminux.net";
const src = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const book = JSON.parse(src("data/contracts.3961.json"));
const bookToken = (a) => book.contracts.some((c) => c.kind === "token" && c.address.toLowerCase() === a.toLowerCase());

let ok = 0, bad = 0;
const check = (name, pass, note = "") => { pass ? ok++ : bad++; console.log(`${pass ? "PASS" : "FAIL"} ${name}${note ? ` · ${note}` : ""}`); };

// 1. selectors
const probe = /FRC721_PROBE = "(0x[0-9a-f]{8})" \+ "([0-9a-f]{8})"\.padEnd\(64, "0"\)/.exec(src("rpc.ts"));
check("FRC721_PROBE is supportsInterface(bytes4) + 0x80ac58cd", !!probe && probe[1] === id("supportsInterface(bytes4)").slice(0, 10) && probe[2] === "80ac58cd", probe ? probe[1] + probe[2] : "not found");
const PROBE = probe ? probe[1] + probe[2].padEnd(64, "0") : "";
const inv = /FRC165_INVALID = "(0x[0-9a-f]{8})" \+ "([0-9a-f]{8})"\.padEnd\(64, "0"\)/.exec(src("rpc.ts"));
check("FRC165_INVALID is supportsInterface(bytes4) + 0xffffffff", !!inv && inv[1] === id("supportsInterface(bytes4)").slice(0, 10) && inv[2] === "ffffffff", inv ? inv[1] + inv[2] : "not found");
const INVALID = inv ? inv[1] + inv[2].padEnd(64, "0") : "";
const sel = Object.fromEntries([...src("pages/tokens/common.ts").matchAll(/(\w+): "(0x[0-9a-f]{8})"/g)].map((m) => [m[1], m[2]]));
const sig = { name: "name()", symbol: "symbol()", decimals: "decimals()", totalSupply: "totalSupply()", cap: "cap()", MAX_ID: "MAX_ID()", maxSupply: "maxSupply()", totalIds: "totalIds()", paused: "paused()", owner: "owner()", minted: "minted(uint256)", ownerOf: "ownerOf(uint256)", tokenURI: "tokenURI(uint256)" };
for (const [k, s] of Object.entries(sig)) check(`SEL.${k} is ${s}`, sel[k] === id(s).slice(0, 10), sel[k] ?? "missing");

// 2. live answers
let rid = 0;
async function batch(calls) {
  const body = calls.map(([to, data]) => ({ jsonrpc: "2.0", id: ++rid, method: "eth_call", params: [{ to, data }, "latest"] }));
  const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const byId = new Map(r.map((x) => [x.id, x]));
  return body.map((b) => { const x = byId.get(b.id); if (!x) throw new Error("RPC dropped a call"); return x.error ? null : x.result; });
}
const cases = [
  { a: "0x5672AF1a567a46BAaFeb66959b7A95666E7f4252", what: "Ferminux Citizens (book, not in the index until its first mint)", want: "FRC-721" },
  { a: "0x84FE97C49Ffe4227d9ea139B5998C097D9C06ddd", what: "Ferminux Agents (book, indexed)", want: "FRC-721" },
  { a: "0xf3e8c83a0472602d04Cd774e3887cBAA76c62147", what: "Identity 8004 (FRC-721 view over AgentRegistry, never emits Transfer)", want: "FRC-721" },
  { a: "0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae", what: "WFMX (book token, FRC-20)", want: "FRC-20" },
  { a: "0xa94f27F18267d09349809f3e2AeF8e7767033e8F", what: "AgentRegistry (book contract, not a token)", want: null },
  { a: "0xc0A5Eb613f859f072554F29f1Ab7400265af15aB", what: "Treasury (an account: eth_call answers 0x)", want: null },
  { a: "0x1234567890abcdef1234567890abcdef12345678", what: "a random address", want: null },
];
for (const c of cases) {
  const [p, v, d] = await batch([[c.a, PROBE], [c.a, INVALID], [c.a, sel.decimals]]);
  const got = classify(p, v, d, bookToken(c.a));
  check(`${c.what} → ${c.want ?? "not a token"}`, (got?.type ?? null) === c.want, `probe=${p === null ? "reverted" : p.slice(0, 10) + "…" + p.slice(-2)} decimals=${d === null ? "reverted" : d.length > 4 ? BigInt(d.slice(0, 66)) : d}`);
}
// the WFMX book entry reads as FRC-20 only because the book calls it a token: outside the book it stays a 404
{
  const [p, v, d] = await batch([["0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae", PROBE], ["0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae", INVALID], ["0x8a9Ae4D652cEba09Db8Ebf48D28C943b41B377Ae", sel.decimals]]);
  check("an FRC-20 outside the book is not read as a token", classify(p, v, d, false) === null);
}
// what the Citizens page shows: name, symbol, the minted count and the cap
{
  const A = "0x5672AF1a567a46BAaFeb66959b7A95666E7f4252";
  const [nm, sy, ts, ti] = await batch([[A, sel.name], [A, sel.symbol], [A, sel.totalSupply], [A, sel.totalIds]]);
  const str = (h) => { const b = h.slice(2); const off = Number(BigInt("0x" + b.slice(0, 64))) * 2; const len = Number(BigInt("0x" + b.slice(off, off + 64))) * 2; return Buffer.from(b.slice(off + 64, off + 64 + len), "hex").toString("utf8"); };
  check("Citizens name() and symbol()", str(nm) === "Ferminux Citizens" && str(sy) === "FMXC", `${str(nm)} (${str(sy)})`);
  check("Citizens totalIds() is the cap, totalSupply() the minted count", BigInt(ti) > 0n && BigInt(ts) <= BigInt(ti), `${BigInt(ts)} minted of ${BigInt(ti)}`);
}
// the pure parts
const W = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
check("classify: supportsInterface false → not a token", classify(W(0), W(0), null, false) === null);
check("classify: true for 0x80ac58cd, false for 0xffffffff → FRC-721", classify(W(1), W(0), null, false)?.type === "FRC-721");
check("classify: true for every id (0xffffffff too) → not a token", classify(W(1), W(1), null, false) === null);
check("classify: a fallback answering any call with a non-bool word → not a token", classify(W(0x1234), W(0x1234), null, false) === null);
check("classify: a longer answer is not a bool → not a token", classify(W(1) + "0".repeat(64), W(0), null, false) === null);
check("classify: 0xffffffff reverted → not a token", classify(W(1), null, null, false) === null);
check("classify: reverted probe, book token without decimals → not a token", classify(null, null, null, true) === null);
check("classify: decimals above 77 → not a token", classify(null, null, W(78), true) === null);
check("classify: short answers are not words", classify("0x01", "0x00", "0x12", true) === null);

console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
