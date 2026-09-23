// Builds the proof-bridge test fixtures from REAL Ferminux blocks, plus a small
// synthetic chain for the attacks real data cannot show (equivocation, forged
// seals, a bridge Sent log in a proven receipt).
//
//   node gen-fixtures.mjs [out.json]      (FMX_RPC overrides the RPC)
//
// Nothing here is trusted blindly: every header we RLP-encode must hash to the
// block hash the node reports, and every receipt trie we rebuild must have the
// receiptsRoot the header commits to. The script aborts otherwise.
import fs from "node:fs";
import { ethers } from "ethers";
import { Trie } from "@ethereumjs/trie";

const RPC = process.env.FMX_RPC || "https://rpc.ferminux.net";
const OUT = process.argv[2] || new URL("../../contracts/test/fixtures/ferminux-proof.json", import.meta.url).pathname;
const EPOCH = 30000;
const POSA_BLOCK = 160000;
const FIRST_CHECKPOINT = 180000; // first multiple of EPOCH after PosaBlock
const WINDOW = 8; // descendants shipped after each target header
const LOG_SOURCES = [
  "0xa94f27F18267d09349809f3e2AeF8e7767033e8F", // AgentRegistry
  "0x99b331495951dB91857902de91EAe9Ff54d8a719", // ServiceEscrow
  "0x8751Cf7e29Fe588c61FDc53323438247198eaa57", // X402Vault
];

const provider = new ethers.JsonRpcProvider(RPC, 3961, { staticNetwork: true });
const rpc = (m, p) => provider.send(m, p);

const q = (x) => {
  const n = BigInt(x ?? 0);
  return n === 0n ? "0x" : ethers.toBeHex(n);
};
const die = (msg) => {
  console.error("FIXTURE ABORT:", msg);
  process.exit(1);
};

function headerFields(b) {
  return [
    b.parentHash, b.sha3Uncles, b.miner, b.stateRoot, b.transactionsRoot, b.receiptsRoot, b.logsBloom,
    q(b.difficulty), q(b.number), q(b.gasLimit), q(b.gasUsed), q(b.timestamp), b.extraData, b.mixHash, b.nonce,
    q(b.baseFeePerGas),
  ];
}

async function rawHeader(n) {
  const b = await rpc("eth_getBlockByNumber", [ethers.toQuantity(n), false]);
  if (!b) die(`block ${n} not found`);
  if (b.baseFeePerGas == null) die(`block ${n} has no baseFee — not a London header`);
  const raw = ethers.encodeRlp(headerFields(b));
  if (ethers.keccak256(raw) !== b.hash) die(`block ${n}: re-encoded header does not hash to ${b.hash}`);
  return { raw, block: b };
}

async function headerRun(start, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push((await rawHeader(start + i)).raw);
  return out;
}

function encodeReceipt(r) {
  const body = ethers.encodeRlp([
    Number(r.status) === 1 ? "0x01" : "0x",
    q(r.cumulativeGasUsed),
    r.logsBloom,
    r.logs.map((l) => [l.address, l.topics, l.data]),
  ]);
  const type = Number(r.type ?? 0);
  return type === 0 ? body : ethers.concat([ethers.toBeHex(type, 1), body]);
}

async function receiptProof(blockNumber, txHash) {
  const b = await rpc("eth_getBlockByNumber", [ethers.toQuantity(blockNumber), false]);
  const trie = new Trie();
  let txIndex = -1;
  let target;
  for (let i = 0; i < b.transactions.length; i++) {
    const r = await rpc("eth_getTransactionReceipt", [b.transactions[i]]);
    const key = ethers.getBytes(ethers.encodeRlp(q(i)));
    const val = ethers.getBytes(encodeReceipt(r));
    await trie.put(key, val);
    if (b.transactions[i].toLowerCase() === txHash.toLowerCase()) {
      txIndex = i;
      target = { receipt: r, raw: ethers.hexlify(val) };
    }
  }
  const root = ethers.hexlify(trie.root());
  if (root !== b.receiptsRoot) die(`block ${blockNumber}: rebuilt receipts root ${root} != header ${b.receiptsRoot}`);
  if (txIndex < 0) die(`tx ${txHash} not in block ${blockNumber}`);
  const key = ethers.getBytes(ethers.encodeRlp(q(txIndex)));
  const proof = (await trie.createProof(key)).map((n) => ethers.hexlify(n));
  return { txIndex, proof, receiptRaw: target.raw, receipt: target.receipt, txCount: b.transactions.length };
}

// ---------------------------------------------------------------- real data
async function realData() {
  const head = await provider.getBlockNumber();
  const checkpoints = [];
  for (let e = FIRST_CHECKPOINT; e + WINDOW <= head; e += EPOCH) {
    const headers = await headerRun(e, WINDOW + 1);
    checkpoints.push({ number: e, headers });
    process.stderr.write(`checkpoint ${e} ok\n`);
  }
  // Receipt proofs: real logs from the agent contracts, preferring a tx that is
  // not first in its block (so the trie key is not the trivial 0x80).
  const logs = [];
  for (const address of LOG_SOURCES) {
    const found = await provider.getLogs({ address, fromBlock: 360000, toBlock: head - WINDOW - 1 });
    logs.push(...found);
  }
  if (logs.length === 0) die("no post-fork logs found to build receipt proofs from");
  const byBlock = new Map();
  for (const l of logs) if (!byBlock.has(l.blockNumber)) byBlock.set(l.blockNumber, l);
  const picks = [];
  for (const l of logs) {
    const b = await rpc("eth_getBlockByNumber", [ethers.toQuantity(l.blockNumber), false]);
    const idx = b.transactions.findIndex((h) => h.toLowerCase() === l.transactionHash.toLowerCase());
    if (idx > 0 && !picks.some((p) => p.idxNonZero)) picks.push({ l, idxNonZero: true });
    if (picks.length === 0 || (picks.length === 1 && picks[0].idxNonZero && idx === 0)) {
      if (!picks.some((p) => !p.idxNonZero)) picks.push({ l, idxNonZero: false });
    }
    if (picks.length >= 2) break;
  }
  const receipts = [];
  for (const { l } of picks) {
    const rp = await receiptProof(l.blockNumber, l.transactionHash);
    const logIndex = rp.receipt.logs.findIndex((x) => Number(x.logIndex) === l.index);
    receipts.push({
      blockNumber: l.blockNumber,
      headers: await headerRun(l.blockNumber, WINDOW + 1),
      txIndex: rp.txIndex,
      txCount: rp.txCount,
      txType: Number(rp.receipt.type ?? 0),
      logIndex,
      proof: rp.proof,
      receiptRaw: rp.receiptRaw,
      log: { address: l.address, topics: l.topics, data: l.data },
    });
    process.stderr.write(`receipt proof block ${l.blockNumber} tx#${rp.txIndex}/${rp.txCount} type ${rp.receipt.type} ok\n`);
  }
  const genesisCheckpoint = await rawHeader(FIRST_CHECKPOINT);
  return {
    chainId: 3961,
    epoch: EPOCH,
    period: 7,
    posaBlock: POSA_BLOCK,
    bootstrap: { number: FIRST_CHECKPOINT, header: genesisCheckpoint.raw, hash: genesisCheckpoint.block.hash },
    checkpoints,
    receipts,
  };
}

// ----------------------------------------------------------- synthetic data
// A private 5-signer Clique chain built here, byte-for-byte in the real header
// format, so the contracts can be shown refusing things mainnet never produces.
const ZERO32 = ethers.ZeroHash;
const EMPTY_UNCLES = "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347";
const EMPTY_TRIE = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421";
const BLOOM0 = "0x" + "00".repeat(256);

function synthKeys(n, salt) {
  return Array.from({ length: n }, (_, i) => new ethers.SigningKey(ethers.id(`ferminux-proof-fixture-${salt}-${i}`)));
}

function sealHeader(fields, key) {
  // fields[12] is the extra WITHOUT the 65-byte seal.
  const sealHash = ethers.keccak256(ethers.encodeRlp(fields));
  const sig = key.sign(sealHash);
  const seal = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.yParity, 1)]);
  const sealed = fields.slice();
  sealed[12] = ethers.concat([fields[12], seal]);
  const raw = ethers.encodeRlp(sealed);
  return { raw, hash: ethers.keccak256(raw) };
}

function synthHeader({ parentHash, number, time, receiptsRoot = EMPTY_TRIE, signersList = null, key, difficulty = 2, vanityByte = "00" }) {
  const vanity = "0x" + vanityByte.repeat(32);
  const extraNoSeal = signersList ? ethers.concat([vanity, ...signersList]) : vanity;
  const fields = [
    parentHash, EMPTY_UNCLES, ethers.ZeroAddress, ZERO32, EMPTY_TRIE, receiptsRoot, BLOOM0,
    q(difficulty), q(number), q(100000000), q(0), q(time), extraNoSeal, ZERO32, "0x0000000000000000", q(7),
  ];
  return sealHeader(fields, key);
}

async function synthetic() {
  const E = 30000 * 10;
  const keys = synthKeys(5, "signer");
  const outsider = synthKeys(1, "outsider")[0];
  const addrs = keys.map((k) => ethers.computeAddress(k.publicKey)).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const keyOf = new Map(keys.map((k) => [ethers.computeAddress(k.publicKey), k]));
  const ordered = addrs.map((a) => keyOf.get(a));
  const t0 = 1_790_000_000;

  // Checkpoint E, then a run signed round-robin by distinct signers.
  const chain = [];
  let parent = ethers.id("synthetic-parent");
  const cp = synthHeader({ parentHash: parent, number: E, time: t0, signersList: addrs, key: ordered[0] });
  chain.push(cp);
  parent = cp.hash;

  // A bridge Sent log inside a real receipt trie, in block E+1.
  const sourceBridge = "0xe162eeDa683f067d4Ebf61060Fa322332a779EF4";
  const sentTopic = ethers.id("Sent(bytes32,uint64,address,uint64,uint64,address,address,address,uint256,uint256)");
  const transfer = {
    srcChainId: 3961n, dstChainId: 56n, nonce: 8n,
    srcToken: ethers.ZeroAddress,
    dstToken: "0x73e64635E2a7b393F2aa3924dcf91fE3cFF51BD0",
    sender: "0x1111111111111111111111111111111111111111",
    recipient: "0x2222222222222222222222222222222222222222",
    amount: ethers.parseEther("99.9"),
  };
  const fee = ethers.parseEther("0.1");
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const transferId = ethers.keccak256(coder.encode(
    ["uint64", "uint64", "uint64", "address", "address", "address", "address", "uint256"],
    [transfer.srcChainId, transfer.dstChainId, transfer.nonce, transfer.srcToken, transfer.dstToken, transfer.sender, transfer.recipient, transfer.amount],
  ));
  const log = {
    address: sourceBridge,
    topics: [sentTopic, transferId, ethers.zeroPadValue(ethers.toBeHex(transfer.dstChainId), 32), ethers.zeroPadValue(transfer.srcToken, 32)],
    data: coder.encode(
      ["uint64", "uint64", "address", "address", "address", "uint256", "uint256"],
      [transfer.srcChainId, transfer.nonce, transfer.dstToken, transfer.sender, transfer.recipient, transfer.amount, fee],
    ),
  };
  const decoyLog = { address: "0x3333333333333333333333333333333333333333", topics: [ethers.id("Other()")], data: "0x" };
  const mkReceipt = (status, logs, type = 2, cum = 50000) => {
    const body = ethers.encodeRlp([status ? "0x01" : "0x", q(cum), BLOOM0, logs.map((l) => [l.address, l.topics, l.data])]);
    return type === 0 ? body : ethers.concat([ethers.toBeHex(type, 1), body]);
  };
  // tx0: unrelated legacy receipt; tx1: the Sent (log index 1, after a decoy); tx2: a FAILED tx carrying a Sent log
  const receiptsList = [mkReceipt(true, [decoyLog], 0, 21000), mkReceipt(true, [decoyLog, log], 2, 90000), mkReceipt(false, [log], 2, 120000)];
  const trie = new Trie();
  for (let i = 0; i < receiptsList.length; i++) await trie.put(ethers.getBytes(ethers.encodeRlp(q(i))), ethers.getBytes(receiptsList[i]));
  const receiptsRoot = ethers.hexlify(trie.root());
  const proofFor = async (i) => (await trie.createProof(ethers.getBytes(ethers.encodeRlp(q(i))))).map((n) => ethers.hexlify(n));

  for (let i = 1; i <= 8; i++) {
    const h = synthHeader({
      parentHash: parent, number: E + i, time: t0 + 7 * i, key: ordered[i % 5],
      receiptsRoot: i === 1 ? receiptsRoot : EMPTY_TRIE,
    });
    chain.push(h);
    parent = h.hash;
  }
  // Safety failure: a second branch from E+1 whose block E+2' is ALSO final —
  // three distinct set members sign it — while the canonical E+2 is final too.
  const conflict = [];
  {
    let p = chain[1].hash;
    for (let i = 0; i < 3; i++) {
      const h = synthHeader({ parentHash: p, number: E + 2 + i, time: t0 + 7 * (2 + i), key: ordered[2 + i], vanityByte: "ee" });
      conflict.push(h.raw);
      p = h.hash;
    }
  }
  // Outsider-signed block and a chain of 3 where only 2 distinct set members sign.
  const outsiderHeader = synthHeader({ parentHash: chain[0].hash, number: E + 1, time: t0 + 7, key: outsider });
  const weak = [];
  {
    let p = chain[0].hash;
    const pattern = [ordered[1], ordered[2], ordered[1], ordered[2]];
    for (let i = 0; i < pattern.length; i++) {
      const h = synthHeader({ parentHash: p, number: E + 1 + i, time: t0 + 7 * (i + 1), key: pattern[i], vanityByte: "77" });
      weak.push(h.raw);
      p = h.hash;
    }
  }
  // Next checkpoint E+EPOCH with a CHANGED set (one signer swapped out), and
  // its finality run signed by members of the old set.
  const newKey = synthKeys(1, "newcomer")[0];
  const newAddrs = [...addrs.slice(1), ethers.computeAddress(newKey.publicKey)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const next = [];
  {
    let p = ethers.id("synthetic-next-parent");
    const E2 = E + 30000;
    const c2 = synthHeader({ parentHash: p, number: E2, time: t0 + 7 * 30000, signersList: newAddrs, key: ordered[1] });
    next.push(c2.raw);
    p = c2.hash;
    for (let i = 1; i <= 4; i++) {
      const h = synthHeader({ parentHash: p, number: E2 + i, time: t0 + 7 * (30000 + i), key: ordered[1 + (i % 4)] });
      next.push(h.raw);
      p = h.hash;
    }
  }
  return {
    epochNumber: E,
    signers: addrs,
    checkpoint: cp.raw,
    chain: chain.map((h) => h.raw),
    conflictBranch: conflict,
    outsiderHeader: outsiderHeader.raw,
    weakChain: weak,
    nextCheckpoint: { number: E + 30000, signers: newAddrs, headers: next },
    sent: {
      sourceBridge,
      transferId,
      transfer: Object.fromEntries(Object.entries(transfer).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
      fee: fee.toString(),
      blockIndex: 1,
      receiptsRoot,
      okProof: { txIndex: 1, logIndex: 1, proof: await proofFor(1) },
      decoyProof: { txIndex: 0, logIndex: 0, proof: await proofFor(0) },
      failedProof: { txIndex: 2, logIndex: 0, proof: await proofFor(2) },
    },
  };
}

const fixture = { generatedAt: new Date().toISOString(), rpc: RPC, real: await realData(), synthetic: await synthetic() };
fs.mkdirSync(new URL(".", `file://${OUT}`).pathname, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 1) + "\n");
console.error(`wrote ${OUT}: ${fixture.real.checkpoints.length} real checkpoints, ${fixture.real.receipts.length} real receipt proofs`);
