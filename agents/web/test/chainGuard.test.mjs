// /buy-fmx/ pays on another chain after switchToChain and a balance check, awaits during which the wallet can move
// to another network. The send must re-read the chain immediately before eth_sendTransaction and refuse if it moved:
// a quote's deposit address and token exist only on the chain the quote was made for.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ChainMovedError, sendOnChain } from "../src/chainGuard.ts";

const TX = { from: "0x5672AF1a567a46BAaFeb66959b7A95666E7f4252", to: "0x000000000000000000000000000000000000dEaD", value: "0x1" };
const HASH = "0x" + "ab".repeat(32);
const wallet = (chain) => {
  const calls = [];
  return {
    calls,
    async request({ method, params }) {
      calls.push(method);
      if (method === "eth_chainId") { if (chain instanceof Error) throw chain; return chain; }
      if (method === "eth_sendTransaction") return HASH;
      throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
    },
  };
};

test("sendOnChain: sends while the wallet is still on the quoted chain", async () => {
  const w = wallet("0x38");
  assert.equal(await sendOnChain(w, 56, TX), HASH);
  assert.deepEqual(w.calls, ["eth_chainId", "eth_sendTransaction"], "the chain is read immediately before the send");
});

test("sendOnChain: reads the chain as a number or decimal string too, as the WalletConnect provider returns it", async () => {
  // @walletconnect/universal-provider answers eth_chainId with parseInt(defaultChain): 56, not "0x38". Read as hex,
  // 56 became 0x56 = 86 and 8453 became 0x8453 = 33875, so every WalletConnect pay-in was refused.
  for (const [chain, quoted] of [[56, 56], [8453, 8453], ["56", 56], ["0x2105", 8453]]) {
    const w = wallet(chain);
    assert.equal(await sendOnChain(w, quoted, TX), HASH, `eth_chainId ${JSON.stringify(chain)} is chain ${quoted}`);
    assert.deepEqual(w.calls, ["eth_chainId", "eth_sendTransaction"]);
  }
  const w = wallet(8453);
  await assert.rejects(sendOnChain(w, 56, TX), (e) => e instanceof ChainMovedError && e.actual === 8453);
  assert.deepEqual(w.calls, ["eth_chainId"]);
});

test("sendOnChain: a wallet that moved, or whose chain cannot be read, sends nothing", async () => {
  for (const [chain, actual] of [["0x2105", 8453], ["0x1", 1], [new Error("disconnected"), null], ["garbage", null]]) {
    const w = wallet(chain);
    await assert.rejects(sendOnChain(w, 56, TX), (e) => e instanceof ChainMovedError && e.expected === 56 && e.actual === actual && /Nothing was sent/.test(e.message));
    assert.deepEqual(w.calls, ["eth_chainId"], "eth_sendTransaction never reached the wallet");
  }
});

test("buy-fmx pays through the guard: both sends carry the quote's chain id, and sendRawTransaction checks it", () => {
  const page = readFileSync(new URL("../src/pages/buy-fmx.ts", import.meta.url), "utf8");
  const sends = [...page.matchAll(/sendRawTransaction\(\{[^}]*\}\)/g)].map((m) => m[0]);
  assert.equal(sends.length, 2, sends.join("\n"));
  for (const s of sends) assert.match(s, /chainId: q\.chainId/, s);
  const wallet = readFileSync(new URL("../src/wallet.ts", import.meta.url), "utf8");
  const raw = wallet.slice(wallet.indexOf("export async function sendRawTransaction"), wallet.indexOf("export async function ethCall"));
  assert.match(raw, /sendOnChain\(eth, tx\.chainId, params\)/);
});
