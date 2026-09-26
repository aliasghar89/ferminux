// An in-memory EVM-ish chain for unit tests: plain value transfers only (every recipient is an account
// with no code), EIP-1559 fee accounting, a pool, blocks on demand, receipts, and the handful of RPC
// methods the runner uses. Deterministic: the test owns the clock and decides when a block is made.
import { Transaction } from "ethers";
import { RpcError, TransportError } from "../dist/rpc.js";

const hex = (n) => "0x" + BigInt(n).toString(16);
const lc = (a) => a.toLowerCase();

export function intrinsic(dataHex, prague = false) {
  const b = Buffer.from(dataHex.replace(/^0x/, ""), "hex");
  let zero = 0;
  for (const x of b) if (x === 0) zero++;
  const nz = b.length - zero;
  const std = 21000n + 4n * BigInt(zero) + 16n * BigInt(nz);
  if (!prague) return std;
  const floor = 21000n + 10n * BigInt(zero + 4 * nz);
  return std > floor ? std : floor;
}

export class FakeChain {
  constructor({ chainId = 3961, baseFee = 7n, gasLimit = 100_000_000n, clock, signersActive = 3, signersTotal = 5 } = {}) {
    this.chainId = chainId;
    this.baseFee = baseFee;
    this.gasLimit = gasLimit;
    this.clock = clock; // () => ms
    this.balances = new Map();
    this.nonces = new Map();
    this.pool = new Map(); // hash -> { tx, raw }
    this.receipts = new Map();
    this.txByHash = new Map();
    this.blocks = [{ number: 0, timestamp: Math.floor(clock() / 1000), baseFee, gasUsed: 0n, txs: [] }];
    this.signersActive = signersActive;
    this.signersTotal = signersTotal;
    this.hold = new Set(); // hashes the "signers" refuse to include (stuck tx)
    this.failNext = []; // [{ method, error }]
    this.calls = new Map(); // method -> count
    this.poolPendingOverride = null;
    this.headTimestampOverride = null;
    this.noClique = false;
    this.organicNext = []; // transactions from other senders for the next block: [{ from, data }]
  }
  /** Put `n` transactions that are not the load test's into the next block (from `from`, with `data`). */
  organic(n, { from = "0x00000000000000000000000000000000000000aa", data = "0x" } = {}) {
    for (let i = 0; i < n; i++) this.organicNext.push({ from, data });
  }
  fund(addr, wei) { this.balances.set(lc(addr), (this.balances.get(lc(addr)) ?? 0n) + wei); }
  balance(addr) { return this.balances.get(lc(addr)) ?? 0n; }
  nonce(addr) { return this.nonces.get(lc(addr)) ?? 0; }
  head() { return this.blocks[this.blocks.length - 1]; }
  pendingNonce(addr) {
    let n = this.nonce(addr);
    const ours = [...this.pool.values()].filter((p) => lc(p.tx.from) === lc(addr)).map((p) => p.tx.nonce).sort((a, b) => a - b);
    for (const x of ours) if (x === n) n++;
    return n;
  }

  /** Make a block from every executable pool transaction (nonce order per sender). */
  confirmBlock() {
    const ts = Math.max(this.head().timestamp + 1, Math.floor(this.clock() / 1000));
    const number = this.head().number + 1;
    const block = { number, timestamp: ts, baseFee: this.baseFee, gasUsed: 0n, txs: [] };
    for (const o of this.organicNext.splice(0)) {
      const hash = "0x" + (this.txByHash.size + 1).toString(16).padStart(64, "0");
      this.txByHash.set(hash, { hash, from: o.from, to: "0x00000000000000000000000000000000000000bb", value: 0n, data: o.data, organic: true });
      this.receipts.set(hash, { transactionHash: hash, blockNumber: hex(number), gasUsed: hex(21000), effectiveGasPrice: hex(this.baseFee), status: "0x1", from: o.from, to: "0x00000000000000000000000000000000000000bb" });
      block.txs.push(hash);
    }
    let progress = true;
    while (progress) {
      progress = false;
      for (const [hash, p] of [...this.pool]) {
        const tx = p.tx;
        if (this.hold.has(hash)) continue;
        if (tx.nonce !== this.nonce(tx.from)) {
          if (tx.nonce < this.nonce(tx.from)) this.pool.delete(hash); // replaced / stale
          continue;
        }
        if (tx.maxFeePerGas < this.baseFee) continue;
        const gasUsed = intrinsic(tx.data);
        const price = tx.maxFeePerGas < this.baseFee + tx.maxPriorityFeePerGas ? tx.maxFeePerGas : this.baseFee + tx.maxPriorityFeePerGas;
        const cost = tx.value + gasUsed * price;
        if (this.balance(tx.from) < tx.value + tx.gasLimit * tx.maxFeePerGas) continue;
        this.balances.set(lc(tx.from), this.balance(tx.from) - cost);
        this.fund(tx.to, tx.value);
        this.nonces.set(lc(tx.from), tx.nonce + 1);
        this.pool.delete(hash);
        // drop other variants of the same nonce
        for (const [h2, p2] of [...this.pool]) if (lc(p2.tx.from) === lc(tx.from) && p2.tx.nonce === tx.nonce) this.pool.delete(h2);
        block.gasUsed += gasUsed;
        block.txs.push(hash);
        this.receipts.set(hash, { transactionHash: hash, blockNumber: hex(number), gasUsed: hex(gasUsed), effectiveGasPrice: hex(price), status: "0x1", from: tx.from, to: tx.to });
        progress = true;
      }
    }
    this.blocks.push(block);
    return block;
  }

  /** All transactions in blocks, oldest first, with their decoded fields. */
  blockTxs() {
    const out = [];
    for (const b of this.blocks) for (const h of b.txs) out.push({ ...this.txByHash.get(h), block: b.number, timestamp: b.timestamp, receipt: this.receipts.get(h) });
    return out;
  }

  count(method) { return this.calls.get(method) ?? 0; }

  async call(method, params = []) {
    this.calls.set(method, this.count(method) + 1);
    const f = this.failNext.findIndex((x) => x.method === method);
    if (f >= 0) { const { error } = this.failNext.splice(f, 1)[0]; throw error; }
    switch (method) {
      case "eth_chainId": return hex(this.chainId);
      case "eth_estimateGas": return hex(intrinsic(params[0].data ?? "0x"));
      case "eth_getCode": return "0x";
      case "eth_getBalance": return hex(this.balance(params[0]));
      case "eth_getTransactionCount": return hex(params[1] === "pending" ? this.pendingNonce(params[0]) : this.nonce(params[0]));
      case "eth_getBlockByNumber": {
        const b = params[0] === "latest" ? this.head() : this.blocks[Number(BigInt(params[0]))];
        if (!b) return null;
        const ts = params[0] === "latest" && this.headTimestampOverride !== null ? this.headTimestampOverride : b.timestamp;
        const txs = params[1] === true ? b.txs.map((h) => { const t = this.txByHash.get(h); return { hash: h, from: t.from, to: t.to, input: t.data ?? "0x" }; }) : b.txs;
        return { number: hex(b.number), timestamp: hex(ts), baseFeePerGas: hex(b.baseFee), gasUsed: hex(b.gasUsed), gasLimit: hex(this.gasLimit), transactions: txs };
      }
      case "eth_blockNumber": return hex(this.head().number);
      case "eth_getBlockTransactionCountByNumber": {
        const b = this.blocks[Number(BigInt(params[0]))];
        return b ? hex(b.txs.length) : null;
      }
      case "eth_getTransactionReceipt": return this.receipts.get(params[0]) ?? null;
      case "eth_sendRawTransaction": {
        const tx = Transaction.from(params[0]);
        if (Number(tx.chainId) !== this.chainId) throw new RpcError("invalid chain id", -32000);
        if (this.receipts.has(tx.hash) || this.pool.has(tx.hash)) throw new RpcError("already known", -32000);
        if (tx.nonce < this.nonce(tx.from)) throw new RpcError("nonce too low", -32000);
        if (tx.gasLimit < intrinsic(tx.data)) throw new RpcError("intrinsic gas too low", -32000);
        if (tx.maxFeePerGas < this.baseFee) throw new RpcError("max fee per gas less than block base fee", -32000);
        if (this.balance(tx.from) < tx.value + tx.gasLimit * tx.maxFeePerGas) throw new RpcError("insufficient funds for gas * price + value", -32000);
        // a replacement must raise both caps by 10 %
        for (const [h, p] of this.pool) {
          if (lc(p.tx.from) === lc(tx.from) && p.tx.nonce === tx.nonce) {
            if (tx.maxFeePerGas * 10n < p.tx.maxFeePerGas * 11n || tx.maxPriorityFeePerGas * 10n < p.tx.maxPriorityFeePerGas * 11n) throw new RpcError("replacement transaction underpriced", -32000);
            this.pool.delete(h);
          }
        }
        this.pool.set(tx.hash, { tx, raw: params[0] });
        this.txByHash.set(tx.hash, { hash: tx.hash, from: tx.from, to: tx.to, value: tx.value, data: tx.data, nonce: tx.nonce, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, gasLimit: tx.gasLimit });
        return tx.hash;
      }
      case "clique_status": {
        if (this.noClique) throw new RpcError("the method clique_status does not exist/is not available", -32601);
        const act = {};
        for (let i = 0; i < this.signersTotal; i++) act["0x" + String(i + 1).padStart(40, "0")] = i < this.signersActive ? 10 : 0;
        return { inturnPercent: 20, numBlocks: 64, sealerActivity: act };
      }
      case "txpool_status": return { pending: hex(this.poolPendingOverride ?? this.pool.size), queued: "0x0" };
      default: throw new RpcError(`the method ${method} does not exist/is not available`, -32601);
    }
  }

  async batch(calls) {
    const out = [];
    for (const c of calls) {
      try { out.push(await this.call(c.method, c.params ?? [])); } catch (e) {
        if (e instanceof TransportError) throw e;
        out.push(e instanceof RpcError ? e : new RpcError(String(e?.message ?? e)));
      }
    }
    return out;
  }
}

/** A fetch for the gateway status and the explorer index, answering from `chain` and `opts`. */
export function fakeFetch(chain, opts = { explorerLag: 0, explorerDown: false, gatewayActive: null }) {
  return async (url) => {
    const u = String(url);
    if (u.includes("/main-page/blocks")) {
      if (opts.explorerDown) throw new Error("connect ECONNREFUSED");
      const h = chain.head().number - (opts.explorerLag ?? 0);
      return new Response(JSON.stringify([{ height: h }, { height: h - 1 }]), { status: 200 });
    }
    // the explorer index's cached network figures (opts.index = { transactions, addresses, last24h }; a test
    // "recounts" by changing them), as EXPLORER_API/stats and EXPLORER_API/transactions/stats answer them
    if (u.endsWith("/api/v2/transactions/stats")) {
      if (!opts.index) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ transactions_count_24h: String(opts.index.last24h) }), { status: 200 });
    }
    if (u.endsWith("/api/v2/stats")) {
      if (!opts.index) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ total_transactions: String(opts.index.transactions), total_addresses: String(opts.index.addresses) }), { status: 200 });
    }
    if (u.includes("/api/status")) {
      const active = opts.gatewayActive ?? chain.signersActive;
      return new Response(JSON.stringify({ services: { chain: { signers: { active, total: chain.signersTotal } } } }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}
