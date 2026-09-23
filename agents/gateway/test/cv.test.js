// The record lane: AI-CV document + signed credential + verification recipe +
// badge, the hiring graph, and FRC-100 memory anchoring.
//
// The cryptography is checked INDEPENDENTLY of the implementation: the merkle
// folds, the canonical JSON hashing and the EIP-712 recovery are all
// re-implemented here from the published rules (and, for the memory tree, from
// MemoryAnchor.sol's own text), so a change to the gateway's helpers that broke
// the published format would fail here rather than agree with itself.
process.env.ALLOW_PRIVATE_FETCH = "1";
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, concat, keccak256, toUtf8Bytes, verifyTypedData, getBytes } from "ethers";
import { buildServer } from "../dist/server.js";
import { openMemoryDb } from "../dist/db.js";
import { canonicalMessage } from "../dist/commons/sign.js";
import { applyV3Event } from "../dist/v3/indexer-v3.js";
import { recordProbe, agentUptime } from "../dist/health.js";

const alice = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // owns agent 7
const bob = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"); // owns agent 8, client of 7
const carol = new Wallet("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"); // outside client
const ZERO32 = `0x${"0".repeat(64)}`;
const tx = (b) => `0x${b.repeat(32)}`;

const cfg = {
  rpcUrl: "http://127.0.0.1:1",
  registry: "0xa94f27F18267d09349809f3e2AeF8e7767033e8F",
  escrow: "0x99b331495951dB91857902de91EAe9Ff54d8a719",
  deployBlock: 0,
  dataDir: ":memory:",
  port: 0,
  publicUrl: "https://ferminux.net",
  pollMs: 1e9,
  probeMs: 1e9,
  toolProbeMs: 1e9,
  bscRpcUrl: "http://127.0.0.1:1",
  payinRpcUrls: { eth: "http://127.0.0.1:1", bsc: "http://127.0.0.1:1", base: "http://127.0.0.1:1", arbitrum: "http://127.0.0.1:1", polygon: "http://127.0.0.1:1", optimism: "http://127.0.0.1:1", avalanche: "http://127.0.0.1:1" },
  payinDeposits: {},
  webhookTickMs: 1e9,
  x402BatchMs: 1e9,
  payinPollMs: 1e9,
  v3: {
    x402Vault: "0x8751Cf7e29Fe588c61FDc53323438247198eaa57",
    streamPay: "0x59404F738A90E5CF725F5837EF40461d1EA2EC35",
    identity8004: "0xf3e8c83a0472602d04Cd774e3887cBAA76c62147",
    reputation8004: "0xd5984C5a187cD6EcF2698eb218988F73FBF08884",
    validation8004: "0x37feB1B3Fb6505d4D584dB0a632F3C20d9eAab97",
    memoryAnchor: "0x1111111111111111111111111111111111111111",
    endorsements: "0x2222222222222222222222222222222222222222",
  },
};

// ---------------------------------------------------------------------------
// Independent re-implementations of the two published constructions.
// ---------------------------------------------------------------------------

/** RFC 8785 JCS: recursively sorted keys, no whitespace, undefined dropped. */
function jcs(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sort(x)));
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sort(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** The audit-export tree the CV uses: untagged leaves, pairwise fold, odd node pairs with itself. */
function cvRoot(leaves) {
  if (!leaves.length) return keccak256("0x");
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(keccak256(concat([level[i], level[i + 1] ?? level[i]])));
    level = next;
  }
  return level[0];
}

/** MemoryAnchor.sol: leaf(h) = keccak256(0x00 ‖ h), node(l,r) = keccak256(0x01 ‖ l ‖ r). */
const memLeaf = (h) => keccak256(concat(["0x00", h]));
const memNode = (l, r) => keccak256(concat(["0x01", l, r]));
function memRoot(leaves) {
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(memNode(level[i], level[i + 1] ?? level[i]));
    level = next;
  }
  return level[0];
}
/** MemoryAnchor.verifyLeaf, transcribed: `count` pins the shape; leftover proof elements are a forgery. */
function memVerify(root, leaf, proof, index, count) {
  if (!root || root === ZERO32 || count === 0 || index >= count) return false;
  let computed = leaf;
  let idx = index;
  let levelSize = count;
  let p = 0;
  while (levelSize > 1) {
    if (idx === levelSize - 1 && levelSize % 2 === 1) computed = memNode(computed, computed);
    else {
      if (p === proof.length) return false;
      const sib = proof[p++];
      computed = idx % 2 === 0 ? memNode(computed, sib) : memNode(sib, computed);
    }
    idx = Math.floor(idx / 2);
    levelSize = Math.floor((levelSize + 1) / 2);
  }
  return p === proof.length && computed.toLowerCase() === root.toLowerCase();
}

async function setup() {
  let nowMs = 1_758_400_000_000;
  const db = openMemoryDb();
  db.prepare(
    "INSERT INTO agents (id, owner, name, endpoint, pricePerJob, bond, status, registeredAt, jobsCompleted, jobsFailed, ratingCount, ratingSum, card, online, lastSeen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)",
  ).run(
    7, alice.address, "Scribe Bot", "https://scribe.example", "100000000000000000", "100000000000000000000", 1, 1_758_000_000, 2, 0, 1, 5,
    JSON.stringify({ ferminux: 1, agentId: 7, description: "Summarises things", capabilities: ["summarize", "translate"], model: "tools", version: "2.1.0", pricePerCall: "1000000000000000" }),
    1_758_399_000_000,
  );
  db.prepare("INSERT INTO agents (id, owner, name, endpoint, pricePerJob, status, registeredAt, card) VALUES (?,?,?,?,?,?,?,?)").run(
    8, bob.address, "Free Bot", "https://free.example", "150000000000000000", 1, 1_758_000_100,
    JSON.stringify({ ferminux: 1, capabilities: ["summarize", "classify"] }),
  );

  // job 1: completed AND rated 5 by an outside client
  db.prepare("INSERT INTO jobs (id, agentId, client, amount, inputHash, inputURI, outputHash, createdAt, deliveredAt, status, txRequested, txDelivered, txClosed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    1, 7, carol.address, "1000000000000000000", tx("11"), "fmx://payload/0x11", tx("22"), 1_758_100_000, 1_758_100_500, 3, tx("a1"), tx("a2"), tx("a3"),
  );
  // job 2: completed but NEVER RATED — ServiceEscrow writes rating 0, which is not zero stars
  db.prepare("INSERT INTO jobs (id, agentId, client, amount, inputHash, inputURI, outputHash, createdAt, deliveredAt, status, txRequested, txClosed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    2, 7, bob.address, "500000000000000000", tx("31"), "fmx://payload/0x31", tx("32"), 1_758_150_000, 1_758_150_400, 3, tx("b1"), tx("b3"),
  );

  const ev = db.prepare("INSERT INTO events (txHash, logIndex, blockNumber, contractName, eventName, argsJSON, ts) VALUES (?,?,?,?,?,?,?)");
  ev.run(tx("bb"), 0, 50, "registry", "AgentRegistered", JSON.stringify({ id: "7", owner: alice.address, name: "Scribe Bot", endpoint: "https://scribe.example", pricePerJob: "100000000000000000", bond: "100000000000000000000" }), 1_758_000_000);
  ev.run(tx("a1"), 0, 100, "escrow", "JobRequested", JSON.stringify({ jobId: "1", agentId: "7", client: carol.address, amount: "1000000000000000000" }), 1_758_100_000);
  ev.run(tx("a3"), 0, 110, "escrow", "JobCompleted", JSON.stringify({ jobId: "1", agentPayout: "975000000000000000", fee: "25000000000000000", rating: "5" }), 1_758_100_900);
  ev.run(tx("b3"), 0, 130, "escrow", "JobCompleted", JSON.stringify({ jobId: "2", agentPayout: "487500000000000000", fee: "12500000000000000", rating: "0" }), 1_758_150_900);
  ev.run(tx("cc"), 0, 140, "x402Vault", "Settled", JSON.stringify({ payer: carol.address, payee: alice.address, amount: "10000000000000000", fee: "100000000000000", nonce: "42" }), 1_758_200_000);
  ev.run(tx("dd"), 0, 150, "streamPay", "PlanCreated", JSON.stringify({ planId: "1", payee: alice.address, pricePerPeriod: "1000000000000000000", period: 2592000, metadataURI: "https://ferminux.net/a/scribe-bot/" }), 1_758_210_000);

  db.prepare("INSERT INTO x402_settlements (txHash, logIndex, payer, payee, amount, fee, nonce, ref, blockNumber, ts) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    tx("cc"), 0, carol.address, alice.address, "10000000000000000", "100000000000000", "42", ZERO32, 140, 1_758_200_000,
  );
  db.prepare("INSERT INTO plans (id, payee, pricePerPeriod, period, active, metadataURI, createdAt) VALUES (?,?,?,?,1,?,?)").run(
    1, alice.address, "1000000000000000000", 2592000, "https://ferminux.net/a/scribe-bot/", 1_758_210_000,
  );
  // one payment-backed FRC-8004 entry (carol paid), one that cost its author nothing (a stranger)
  const fb = db.prepare("INSERT INTO reputation_feedback (txHash, logIndex, agentId, client, value, valueDecimals, tag1, tag2, feedbackURI, ts) VALUES (?,?,?,?,?,?,?,?,?,?)");
  fb.run(tx("e1"), 0, 7, carol.address, "5", 0, "endorse", "summarize", "", 1_758_220_000);
  fb.run(tx("e2"), 0, 7, "0x000000000000000000000000000000000000dEaD", "5", 0, "endorse", "summarize", "", 1_758_220_100);
  // a validation the agent's OWNER named itself for — self-attested, and the CV must say so
  db.prepare("INSERT INTO validations (requestHash, validator, agentId, jobId, requestURI, response, responseURI, tag, requestedAt, respondedAt, txRequest, txResponse) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    tx("f1"), alice.address, 7, 1, "fmx://job/1", 100, "", "delivery", 1_758_230_000, 1_758_230_100, tx("f2"), tx("f3"),
  );
  db.prepare("INSERT INTO activity (type, ts, actor, refKind, refId, data, dedupKey) VALUES ('kb.write', ?, ?, 'kb', 'guide', '{}', 'kb1')").run(1_758_240_000, alice.address);
  db.prepare("INSERT INTO meta (key, value) VALUES ('indexedBlock', '383565')").run();

  const { app, activity, webhooks, v3 } = await buildServer({
    db,
    cfg,
    workers: false,
    logger: false,
    commons: { now: () => nowMs, forward: async () => {}, toolProbeFetch: async () => new Response(null, { status: 200 }) },
    v3: { fetchImpl: async () => new Response("ok", { status: 200 }) },
  });
  await app.ready();

  const clock = { s: () => Math.floor(nowMs / 1000), advance: (ms) => (nowMs += ms), ms: () => nowMs };
  const signed = async (wallet, action, payload = {}) => {
    const ts = clock.s();
    const sig = await wallet.signMessage(canonicalMessage(action, wallet.address, ts, payload));
    return { ...payload, address: wallet.address, ts, sig };
  };
  const inject = (method, url, body) => app.inject({ method, url, headers: { "content-type": "application/json" }, payload: body === undefined ? undefined : JSON.stringify(body) });
  const get = async (url) => {
    const r = await app.inject({ method: "GET", url });
    return { status: r.statusCode, headers: r.headers, body: r.body, json: () => r.json() };
  };
  const put = async (key, value) => {
    const r = await inject("PUT", `/api/memory/${key}`, await signed(alice, "memory.put", { key, value }));
    clock.advance(1500);
    return r;
  };
  const del = async (key) => {
    const r = await inject("DELETE", `/api/memory/${key}`, await signed(alice, "memory.delete", { key }));
    clock.advance(1500);
    return r;
  };
  const v3Event = (key, name, args, { block = 400000, txHash = tx("99"), logIndex = 0, ts = clock.s() } = {}) =>
    applyV3Event({ db, activity, webhooks }, { key, parsed: { name }, args, blockNumber: block, txHash, logIndex, ts });

  return { app, db, v3, clock, signed, inject, get, put, del, v3Event };
}

// ---------------------------------------------------------------------------

test("GET /api/cv/:agent assembles every source with per-claim provenance", async (t) => {
  const { app, get } = await setup();
  t.after(() => app.close());

  const res = await get("/api/cv/7");
  assert.equal(res.status, 200);
  const doc = res.json();

  assert.equal(doc["@context"][0], "https://www.w3.org/ns/credentials/v2");
  assert.deepEqual(doc.type, ["VerifiableCredential", "FerminuxAgentCV"]);
  assert.equal(doc.credentialSubject.agent.agentId, 7);
  assert.equal(doc.credentialSubject.agent.chainId, 3961);
  assert.equal(doc.credentialSubject.id, `did:pkh:eip155:3961:${alice.address}`);
  assert.match(doc.credentialSubject.agent.identityKey, /agentId/);

  const types = doc.credentialSubject.record.map((c) => c.type);
  for (const want of ["Registration", "AgentState", "EscrowJob", "X402Receipt", "SubscriptionPlan", "Feedback", "Validation", "Contribution", "Reliability", "Capability"]) {
    assert.ok(types.includes(want), `missing claim type ${want}`);
  }

  // every claim declares how it is proved, and only chain claims say `proven`
  for (const c of doc.credentialSubject.record) {
    assert.ok(["chain", "gateway", "selfAttested"].includes(c.evidence.trust), c.id);
    assert.ok(["chain", "signed", "observed", "declared"].includes(c.evidence.provenance), c.id);
    assert.equal(c.evidence.proven, c.evidence.trust === "chain", c.id);
    if (c.evidence.trust === "chain" && c.evidence.method === "eth_call") {
      // Mutable registry state: no transaction carries its CURRENT value, so
      // the claim names the contract and the call, and the verifier re-reads it.
      assert.equal(c.evidence.address, cfg.registry, c.id);
      assert.match(c.evidence.call, /^getAgent\(\d+\)$/, c.id);
      assert.equal(c.evidence.tx, undefined, c.id);
    } else if (c.evidence.trust === "chain") {
      assert.match(c.evidence.tx, /^0x[0-9a-f]{64}$/i, c.id);
      assert.match(c.evidence.topic0, /^0x[0-9a-f]{64}$/i, c.id);
      assert.ok(c.evidence.address, c.id);
      assert.ok(c.evidence.event.includes("("), c.id);
      assert.equal(c.evidence.method, "eth_getTransactionReceipt");
      assert.equal(c.evidence.logIndex, undefined, `${c.id}: the ambiguous name is gone; the field is blockLogIndex`);
    } else {
      assert.ok(c.evidence.note, `${c.id} asserts without saying who asserts it`);
    }
  }

  // topic0 really is keccak256 of the signature it states
  const reg = doc.credentialSubject.record.find((c) => c.type === "Registration");
  assert.equal(reg.evidence.topic0, keccak256(toUtf8Bytes(reg.evidence.event)));
  assert.equal(reg.evidence.address, cfg.registry);

  // THE SPLIT. AgentRegistered proves what was registered, never what is true
  // now. An attacker who rewrote `endpoint` inside a proven Registration claim
  // passed every published step, because the bind set was {id, owner} and the
  // endpoint is where a client sends work and money.
  for (const banned of ["endpoint", "status", "pricePerJobWei", "bondWei", "metadataURI"]) {
    assert.equal(reg[banned], undefined, `Registration must not carry mutable state (${banned})`);
  }
  assert.equal(typeof reg.endpointAtRegistration, "string");
  assert.match(reg.mutableNote, /NOT proved here/);
  for (const f of ["name", "endpoint", "pricePerJob", "bond"]) {
    assert.ok(reg.evidence.bind.some((b) => b.log === f), `the registration log's ${f} is bound`);
  }

  const state = doc.credentialSubject.record.find((c) => c.type === "AgentState");
  assert.equal(state.evidence.method, "eth_call");
  assert.equal(state.evidence.proven, true);
  assert.equal(state.endpoint, "https://scribe.example");
  assert.equal(state.status, "Active");
  assert.match(state.note, /read live/);

  // a completed-but-unrated job carries null, never 0
  const jobs = doc.credentialSubject.record.filter((c) => c.type === "EscrowJob");
  assert.equal(jobs.length, 2);
  assert.equal(jobs.find((j) => j.jobId === 1).rating, 5);
  assert.equal(jobs.find((j) => j.jobId === 2).rating, null);
  assert.match(jobs.find((j) => j.jobId === 2).ratingNote, /unrated/);

  // the bind rules tie each log to THIS subject
  const job1 = jobs.find((j) => j.jobId === 1);
  assert.ok(job1.evidence.bind.some((b) => b.call?.field === "agentId" && b.equals === "subject.agentId"));
  // …and the money and the rating, which sit in the very log the claim cites
  // and for a while were compared to nothing at all.
  assert.ok(job1.evidence.bind.some((b) => b.log === "agentPayout" && b.equals === "claim.payoutWei"));
  assert.ok(job1.evidence.bind.some((b) => b.log === "fee" && b.equals === "claim.feeWei"));
  assert.ok(job1.evidence.bind.some((b) => b.log === "rating" && b.equals === "claim.rating|0"));

  const s = doc.credentialSubject.summary;
  assert.equal(s.escrowEarnedWei, (975000000000000000n + 487500000000000000n).toString());
  assert.equal(s.escrowFeesWei, (25000000000000000n + 12500000000000000n).toString());
  // NET of the vault fee, exactly like escrowEarnedWei. Gross is still there,
  // named gross — a reader recomputing "earned" from the chain and getting a
  // different number cannot tell that apart from tampering.
  assert.equal(s.x402GrossWei, "10000000000000000");
  assert.equal(BigInt(s.x402EarnedWei), 10000000000000000n - BigInt(s.x402FeesWei));
  assert.match(s.earnedNote, /NET of the protocol fee/);

  // no counter is printed without the qualifier that says what it is worth
  assert.equal(typeof s.armsLength.paidJobsCompleted, "number");
  assert.equal(typeof s.armsLength.zeroValueJobs, "number");
  assert.equal(typeof s.armsLength.distinctPayers, "number");
  assert.match(s.armsLength.stillBuyable, /second address the same operator controls/);
  assert.equal(s.unratedCompletions, 1);
  assert.equal(s.feedback.paymentBacked, 1);
  assert.equal(s.feedback.unbacked, 1);
  assert.equal(s.validations.selfAttested, 1);
  assert.equal(s.verify.address, cfg.registry);

  // feedback whose author never paid is labelled, not averaged away silently
  const unbacked = doc.credentialSubject.record.find((c) => c.type === "Feedback" && c.paymentBacked === false);
  assert.match(unbacked.paymentBackedNote, /no paid record/);
  // a validation the owner named itself for says "self-attested" in those words
  const val = doc.credentialSubject.record.find((c) => c.type === "Validation");
  assert.equal(val.selfAttested, true);
  assert.equal(val.validatorTier, "self");
  assert.match(val.validatorNote, /self-attested/);

  // completeness is attested, never claimed as proof
  assert.match(doc.credentialSubject.recordMeta.completenessNote, /not 'fully trustless'|not .fully trustless./);
  assert.equal(res.headers["x-ferminux-claims-root"], doc.claimsRoot);
  assert.equal(res.headers["x-ferminux-document-hash"], doc.documentHash);
});

test("claimsRoot and documentHash are reproducible from the published rules alone", async (t) => {
  const { app, get } = await setup();
  t.after(() => app.close());
  const doc = (await get("/api/cv/7")).json();

  // each leaf = keccak256(utf8(JCS(claim without `leaf`)))
  const leaves = doc.credentialSubject.record.map((claim) => {
    const { leaf, ...rest } = claim;
    assert.equal(keccak256(toUtf8Bytes(jcs(rest))), leaf, claim.id);
    return leaf;
  });
  assert.equal(cvRoot(leaves), doc.claimsRoot);

  // documentHash = keccak256(utf8(JCS(document without `proof` and `documentHash`)))
  const { documentHash, proof, ...body } = doc;
  assert.equal(keccak256(toUtf8Bytes(jcs(body))), documentHash);

  // the document says exactly that, so a reader needs no other source
  assert.match(doc.hashing.documentHash, /without .proof. and without .documentHash./);
  assert.match(doc.hashing.note, /MemoryAnchor/);
});

test("credential.json: EIP-712 proof recovers the published gateway signer and binds both roots", async (t) => {
  const { app, get } = await setup();
  t.after(() => app.close());

  const health = (await get("/api/health")).json();
  const res = await get("/api/cv/7/credential.json");
  assert.equal(res.status, 200);
  const doc = res.json();
  const [proof] = doc.proof;

  assert.equal(proof.type, "DataIntegrityProof");
  assert.equal(proof.cryptosuite, "eip712-jcs-2026");
  assert.match(proof.cryptosuiteNote, /not a registered Data Integrity cryptosuite/);
  assert.equal(proof.eip712.domain.name, "Ferminux AI-CV");
  assert.equal(proof.eip712.domain.chainId, 3961);
  assert.equal(proof.eip712.domain.verifyingContract, cfg.v3.identity8004);
  assert.equal(proof.eip712.types.AgentCV.length, 11);

  // the signed message commits to both roots and to the subject
  assert.equal(proof.eip712.message.claimsRoot, doc.claimsRoot);
  assert.equal(proof.eip712.message.documentHash, doc.documentHash);
  assert.equal(proof.eip712.message.agentId, 7);
  assert.equal(proof.eip712.message.subject, alice.address);
  assert.equal(proof.eip712.message.registry, cfg.registry);

  const recovered = verifyTypedData(proof.eip712.domain, proof.eip712.types, proof.eip712.message, proof.proofValue);
  assert.equal(recovered, health.signer);
  assert.equal(res.headers["x-ferminux-signer"], health.signer);
  assert.equal(proof.verificationMethod, `did:pkh:eip155:3961:${health.signer}#blockchainAccountId`);
  assert.match(proof.attests, /completeness of the off-chain half/);

  // the signature covers the roots, so the document bytes must still hash to the signed hash
  const { documentHash, proof: _p, ...body } = doc;
  assert.equal(keccak256(toUtf8Bytes(jcs(body))), proof.eip712.message.documentHash);

  // tampering with one claim breaks the root the signature commits to
  const tampered = structuredClone(doc);
  tampered.credentialSubject.record[0].statedAt = 1;
  const { leaf: _l, ...rest } = tampered.credentialSubject.record[0];
  assert.notEqual(keccak256(toUtf8Bytes(jcs(rest))), tampered.credentialSubject.record[0].leaf);
});

test("credential.json?signer=owner hands back an unsigned payload for the on-chain owner key", async (t) => {
  const { app, get } = await setup();
  t.after(() => app.close());

  const doc = (await get("/api/cv/7/credential.json?signer=owner")).json();
  const [proof] = doc.proof;
  assert.equal(proof.proofValue, null);
  assert.equal(proof.verificationMethod, `did:pkh:eip155:3961:${alice.address}#blockchainAccountId`);
  assert.match(proof.sign, /AgentRegistry\.getAgent\(agentId\)\.owner/);

  // the owner can sign it, and the result recovers to the address the registry names
  const sig = await alice.signTypedData(proof.eip712.domain, proof.eip712.types, proof.eip712.message);
  assert.equal(verifyTypedData(proof.eip712.domain, proof.eip712.types, proof.eip712.message, sig), alice.address);
  assert.equal(getBytes(sig).length, 65);

  assert.equal((await get("/api/cv/7/credential.json?signer=nope")).status, 400);
});

test("GET /api/cv/:agent/verify is a complete recipe with an explicit trust boundary", async (t) => {
  const { app, get } = await setup();
  t.after(() => app.close());

  const v = (await get("/api/cv/7/verify")).json();
  assert.equal(v.agentId, 7);
  assert.equal(v.chainId, 3961);
  assert.deepEqual(v.rpc, ["https://rpc.ferminux.net"]);
  assert.equal(v.steps.length, 11);
  assert.deepEqual(v.steps.map((s) => s.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  for (const s of v.steps) assert.ok(s.name && s.do, JSON.stringify(s));

  // the one call that bounds the headline numbers is step 5 and names the registry
  assert.match(v.steps[4].do, new RegExp(cfg.registry));
  // step 5 runs in BOTH directions: understating failures is a lie too
  assert.match(v.steps[4].must, /must not be LESS/);
  // step 6 is the one whose absence was a total break: pin the contracts first
  assert.match(v.steps[5].do, /YOUR OWN list/);
  assert.match(v.steps[5].note, /may never choose the contract that answers/);
  // step 7 compares every stated field, not just the identifiers
  assert.match(v.steps[6].do, /payout, fee, rating, amount/);
  // step 8 re-reads the mutable half live
  assert.match(v.steps[7].do, /getAgent/);
  // and the addresses to pin are published, so "pin them" is actionable
  assert.equal(v.contracts.agentRegistry, cfg.registry);
  assert.match(v.contracts.note, /PIN THESE/);
  // the issuer key is not to be learned from the issuer
  assert.match(v.steps[3].note, /DO NOT learn the issuer key/);

  assert.ok(v.trustBoundary.chainProves.length >= 6);
  assert.ok(v.trustBoundary.gatewayAsserts.some((x) => /uptime/i.test(x)));
  assert.ok(v.trustBoundary.operatorDeclares.some((x) => /capabilities/i.test(x)));
  assert.ok(v.trustBoundary.neverProved.some((x) => /unrated/i.test(x)));
  assert.ok(v.trustBoundary.neverProved.some((x) => /msg\.value = 0/.test(x)));
  assert.ok(v.commands.some((c) => c.includes("cast call") && c.includes(cfg.registry)));
  assert.match(v.portability, /Ferminux is an index, not the trust root/);

  // the recipe's hashes are the document's hashes
  const doc = (await get("/api/cv/7")).json();
  assert.equal(v.claimsRoot, doc.claimsRoot);
  assert.equal(v.documentHash, doc.documentHash);
  assert.equal(v.eip712.digest.length, 66);
});

test("badge.svg is self-contained, themed, and cached for 5 minutes", async (t) => {
  const { app, get } = await setup();
  t.after(() => app.close());

  const flat = await get("/api/cv/7/badge.svg");
  assert.equal(flat.status, 200);
  assert.match(flat.headers["content-type"], /image\/svg\+xml/);
  assert.equal(flat.headers["cache-control"], "public, max-age=300");
  assert.match(flat.body, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  // camo strips scripts, webfonts and external refs — a badge that needs them renders as nothing
  assert.ok(!/<script/i.test(flat.body));
  assert.ok(!/@import|<image|xlink:href|href="http/i.test(flat.body));
  assert.ok(flat.body.includes("Scribe Bot"));
  // the number carries its qualifier: jobs that MOVED FMX, never the raw counter
  assert.ok(flat.body.includes("2 paid jobs"), flat.body);
  // the build time is in the title, so a stale badge is self-dating
  assert.match(flat.body, /<title>Ferminux record: Scribe Bot #7 \(Active\) — 2 paid job\(s\) from \d+ payer\(s\).*Built \d{4}-/);

  // a rating never travels without its sample size
  const rated = await get("/api/cv/7/badge.svg?metric=rating");
  assert.match(rated.body, /5\.0★ \(1\)/);
  // an unrecognised metric is refused rather than silently answered with jobs
  assert.equal((await get("/api/cv/7/badge.svg?metric=proofs")).status, 400);

  const card = await get("/api/cv/scribe-bot/badge.svg?style=card&theme=dark");
  assert.ok(card.body.includes('width="320"'));
  assert.ok(card.body.includes("#14161a"));
  assert.ok(card.body.includes("5.0★") || card.body.includes("5.0"));

  const earned = await get("/api/cv/7/badge.svg?metric=earned");
  assert.ok(earned.body.includes("FMX"));
  assert.equal((await get("/api/cv/999/badge.svg")).status, 404);
});

test("the CV resolves by id or slug, and a slug never leaves the earliest claimant", async (t) => {
  const { app, db, get } = await setup();
  t.after(() => app.close());

  assert.equal((await get("/api/cv/scribe-bot")).json().credentialSubject.agent.agentId, 7);

  // a squatter registers the same name and the real agent pauses for maintenance
  db.prepare("INSERT INTO agents (id, owner, name, endpoint, status, registeredAt) VALUES (?,?,?,?,?,?)").run(99, bob.address, "Scribe  Bot", "https://squat.example", 1, 1_758_300_000);
  db.prepare("UPDATE agents SET status = 2 WHERE id = 7").run();

  // the slug still resolves to #7 — status must never move a name, because /a/<slug>/invoke pays the owner
  assert.equal((await get("/api/cv/scribe-bot")).json().credentialSubject.agent.agentId, 7);
  assert.equal((await get("/a/scribe-bot/.well-known/agent.json")).json().ferminux.agentId, 7);

  // and the collision is disclosed rather than hidden
  const collisions = (await get("/api/cv/7")).json().credentialSubject.agent.nameCollisions;
  assert.equal(collisions.count, 2);
  assert.deepEqual(collisions.agents.map((a) => a.agentId), [7, 99]);
  assert.match(collisions.note, /does not make names unique/);
});

test("GET /api/network builds the hiring graph from escrow and x402, with filters", async (t) => {
  const { app, get } = await setup();
  t.after(() => app.close());

  const g = (await get("/api/network")).json();
  assert.equal(g.chainId, 3961);
  assert.equal(g.counts.hireEdges, 2); // carol → 7, bob(agent 8) → 7
  assert.equal(g.counts.x402Edges, 1);
  assert.equal(g.counts.externalClients, 1); // carol owns no agent

  const hire = g.edges.filter((e) => e.kind === "hire");
  const fromAgent = hire.find((e) => e.fromAgentId === 8);
  assert.equal(fromAgent.toAgentId, 7);
  assert.equal(fromAgent.fromName, "Free Bot");
  const fromStranger = hire.find((e) => e.fromAgentId === null);
  assert.equal(fromStranger.from, carol.address);
  assert.equal(fromStranger.volumeWei, "1000000000000000000");
  assert.equal(fromStranger.avgRating, 5);
  assert.deepEqual(fromStranger.jobIds, [1]);
  for (const e of g.edges) assert.equal(e.provenance, "chain");
  assert.match(g.caution, /farmable/);

  // nodes carry their CV link, which is what makes the graph navigable
  assert.ok(g.nodes.find((n) => n.agentId === 7).cv.endsWith("/api/cv/7"));

  assert.equal((await get("/api/network?kind=x402")).json().counts.hireEdges, 0);
  assert.equal((await get("/api/network?kind=hire")).json().counts.x402Edges, 0);
  assert.equal((await get("/api/network?capability=translate")).json().counts.edges, 3); // only agent 7 declares it
  assert.equal((await get("/api/network?capability=nothing-declares-this")).json().counts.edges, 0);
  assert.equal((await get("/api/network?minJobs=2")).json().counts.edges, 0);
  assert.equal((await get("/api/network?kind=bogus")).status, 400);
});

test("GET /api/network/similar/:agent explains why, and never ships an opaque score", async (t) => {
  const { app, get } = await setup();
  t.after(() => app.close());

  const s = (await get("/api/network/similar/7")).json();
  assert.equal(s.agentId, 7);
  const free = s.items.find((i) => i.agentId === 8);
  assert.deepEqual(free.sharedCapabilities, ["summarize"]);
  assert.match(free.reason, /shares 1 capability \(summarize\)/);
  assert.equal(free.clientsInCommon, 0);
  assert.equal(free.samePriceBand, true); // 0.1 vs 0.15 FMX
  assert.ok(free.cv.endsWith("/api/cv/8"));
  assert.equal(free.rank, undefined); // the reason is the output, not a number to trust
  assert.match(s.method.capabilities, /declared, never proved/);
  assert.match(s.method.ranking, /recompute it yourself/);
  assert.equal((await get("/api/network/similar/nope")).status, 404);
});

test("memory writes append a salted, chained record and POST /api/memory/anchor folds them into the contract's tree", async (t) => {
  const { app, db, get, put, del, inject, signed, clock } = await setup();
  t.after(() => app.close());

  const first = await put("alpha", { a: 1 });
  assert.equal(first.statusCode, 201);
  const rec = first.json().record;
  assert.equal(rec.seq, 1);
  assert.equal(rec.prev, ZERO32);
  assert.equal(rec.valueHash, keccak256(toUtf8Bytes(JSON.stringify({ a: 1 }))));

  await put("beta", "hello");
  const again = await put("alpha", { a: 2 });
  await del("beta");

  // the key commitment is salted, so writing the same key twice never repeats a commitment
  assert.notEqual(again.json().record.keyCommit, rec.keyCommit);
  // and the chain links: every record's prev is the previous recordHash
  const rows = db.prepare("SELECT seq, prev, recordHash, op FROM memory_records WHERE address = ? ORDER BY seq").all(alice.address);
  assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4]);
  assert.deepEqual(rows.map((r) => r.op), ["put", "put", "put", "del"]);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prev, rows[i - 1].recordHash);
  // a tombstone commits to nothing
  assert.equal(db.prepare("SELECT valueHash FROM memory_records WHERE address = ? AND seq = 4").get(alice.address).valueHash, ZERO32);

  const built = await inject("POST", "/api/memory/anchor", await signed(alice, "memory.anchor", { agentId: 7, uri: "fmx://memory/7" }));
  clock.advance(1500);
  assert.equal(built.statusCode, 201, built.body);
  const batch = built.json();
  assert.equal(batch.count, 4);
  assert.equal(batch.fromSeq, 1);
  assert.equal(batch.toSeq, 4);
  assert.equal(batch.prevRoot, ZERO32);
  assert.equal(batch.status, "built");
  assert.equal(batch.uri, "fmx://memory/7");

  // the root is the contract's root, recomputed here from MemoryAnchor.sol's own rules
  const leaves = batch.records.map((r) => {
    assert.equal(Buffer.from(r.recordBytes.slice(2), "hex").toString("utf8"), r.recordJson);
    assert.equal(keccak256(toUtf8Bytes(r.recordJson)), r.recordHash);
    assert.equal(memLeaf(r.recordHash), r.leaf);
    // the header is only commitments — no key name, no value
    assert.equal(JSON.stringify(r.record).includes("alpha"), false);
    assert.ok(r.record.keyCommit && r.record.valueHash !== undefined);
    return r.leaf;
  });
  assert.equal(memRoot(leaves), batch.root);
  // and every proof folds back to it under the contract's index/count walk
  batch.records.forEach((r, i) => {
    assert.equal(r.index, i);
    assert.equal(memVerify(batch.root, r.leaf, r.proof, i, leaves.length), true, `proof ${i}`);
    assert.equal(memVerify(batch.root, r.leaf, r.proof, (i + 1) % leaves.length, leaves.length), false, `proof ${i} must not verify at the wrong index`);
  });
  // an appended sibling is a forgery, not a longer proof
  assert.equal(memVerify(batch.root, batch.records[0].leaf, [...batch.records[0].proof, ZERO32], 0, leaves.length), false);

  // the owner gets the salts back so it can open one key to one verifier
  assert.equal(batch.records[0].key, "alpha");
  assert.ok(batch.records[0].keyNonce);
  assert.equal(keccak256(toUtf8Bytes(JSON.stringify({ key: batch.records[0].key, nonce: batch.records[0].keyNonce }))), batch.records[0].keyCommit);

  // the calldata a wallet sends, and the 1 gwei floor the signers enforce
  assert.equal(batch.onchain.contract, cfg.v3.memoryAnchor);
  assert.match(batch.onchain.calldata, /^0x[0-9a-f]+$/);
  assert.equal(batch.onchain.priorityFeeFloorWei, "1000000000");
  assert.equal(batch.onchain.relayed.eip712.domain.name, "FerminuxMemoryAnchor");
});

test("anchoring is idempotent, records its tx, and the indexer confirms it", async (t) => {
  const { app, get, put, inject, signed, clock, v3Event } = await setup();
  t.after(() => app.close());

  await put("alpha", { a: 1 });
  await put("beta", { b: 2 });

  const first = (await inject("POST", "/api/memory/anchor", await signed(alice, "memory.anchor", { agentId: 7 }))).json();
  clock.advance(1500);
  // a retry while the batch is unanchored returns the SAME root — a retry must never fork the log
  const retry = await inject("POST", "/api/memory/anchor", await signed(alice, "memory.anchor", { agentId: 7 }));
  clock.advance(1500);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().root, first.root);
  assert.equal(retry.json().rebuilt, false);

  // record the transaction the owner sent
  const submitted = await inject("POST", "/api/memory/anchor", await signed(alice, "memory.anchor", { agentId: 7, root: first.root, txHash: tx("77") }));
  clock.advance(1500);
  assert.equal(submitted.statusCode, 200);
  assert.equal(submitted.json().status, "submitted");
  assert.equal(submitted.json().tx, tx("77"));

  // the indexer sees MemoryAnchored and confirms it
  v3Event("memoryAnchor", "MemoryAnchored", { agentId: "7", seq: "1", root: first.root, prevRoot: ZERO32, count: "2", totalRecords: "2", anchoredBy: alice.address, uri: "" }, { block: 400123, txHash: tx("77") });
  const anchors = (await get("/api/memory/anchors?agentId=7")).json();
  assert.equal(anchors.total, 1);
  assert.equal(anchors.items[0].status, "anchored");
  assert.equal(anchors.items[0].onchainSeq, 1);
  assert.equal(anchors.items[0].block, 400123);
  assert.equal(anchors.contract, cfg.v3.memoryAnchor);

  // a second batch chains onto the first root
  await put("gamma", { c: 3 });
  const second = (await inject("POST", "/api/memory/anchor", await signed(alice, "memory.anchor", { agentId: 7 }))).json();
  clock.advance(1500);
  assert.equal(second.prevRoot, first.root);
  assert.equal(second.fromSeq, 3);
  v3Event("memoryAnchor", "MemoryAnchored", { agentId: "7", seq: "2", root: second.root, prevRoot: first.root, count: "1", totalRecords: "3", anchoredBy: alice.address, uri: "" }, { block: 400200, txHash: tx("78") });

  // every record is now in an anchored batch → 409, not an empty root
  const empty = await inject("POST", "/api/memory/anchor", await signed(alice, "memory.anchor", { agentId: 7 }));
  clock.advance(1500);
  assert.equal(empty.statusCode, 409);
  assert.match(empty.json().error, /nothing to anchor/);

  // only the owner may anchor under an agent id
  const notOwner = await inject("POST", "/api/memory/anchor", await signed(bob, "memory.anchor", { agentId: 7 }));
  assert.equal(notOwner.statusCode, 403);
});

test("GET /api/memory/proof/:agentId/:seq is a self-contained bundle a stranger can check", async (t) => {
  const { app, get, put, inject, signed, clock, v3Event } = await setup();
  t.after(() => app.close());

  await put("alpha", { a: 1 });
  await put("beta", { b: 2 });
  await put("gamma", { c: 3 });
  const batch = (await inject("POST", "/api/memory/anchor", await signed(alice, "memory.anchor", { agentId: 7 }))).json();
  clock.advance(1500);
  v3Event("memoryAnchor", "MemoryAnchored", { agentId: "7", seq: "1", root: batch.root, prevRoot: ZERO32, count: "3", totalRecords: "3", anchoredBy: alice.address, uri: "" }, { block: 400500, txHash: tx("88") });

  const p = (await get("/api/memory/proof/7/2")).json();
  assert.equal(p.anchored, true);
  assert.equal(p.status, "anchored");
  assert.equal(p.seq, 2);
  assert.equal(p.index, 1);
  assert.equal(p.count, 3);
  assert.equal(p.selfCheck, true);
  assert.equal(memVerify(p.batch.root, p.leaf, p.proof, p.index, p.count), true);
  assert.equal(p.onchain.tx, tx("88"));
  assert.equal(p.onchain.call, "verify(bytes32 root, bytes record, bytes32[] proof, uint256 index, uint256 count) returns (bool)");
  assert.deepEqual(p.onchain.args, [p.batch.root, p.recordBytes, p.proof, 1, 3]);
  // the public bundle never reveals the key or the salt
  assert.equal(p.key, undefined);
  assert.equal(p.keyNonce, undefined);
  // continuity: prev links to seq 1, so a dropped record would leave a visible gap
  const prev = (await get("/api/memory/proof/7/1")).json();
  assert.equal(p.continuity.prev, prev.recordHash);
  assert.equal(p.continuity.logHead.seq, 3);

  const unanchored = await get("/api/memory/proof/7/99");
  assert.equal(unanchored.status, 404);
  assert.equal((await get("/api/memory/proof/999/1")).status, 404);
});

test("the CV carries memory anchors, endorsements and uptime once they exist", async (t) => {
  const { app, db, get, put, inject, signed, clock, v3Event } = await setup();
  t.after(() => app.close());

  await put("alpha", { a: 1 });
  const batch = (await inject("POST", "/api/memory/anchor", await signed(alice, "memory.anchor", { agentId: 7 }))).json();
  clock.advance(1500);
  v3Event("memoryAnchor", "MemoryAnchored", { agentId: "7", seq: "1", root: batch.root, prevRoot: ZERO32, count: "1", totalRecords: "1", anchoredBy: alice.address, uri: "" }, { block: 401000, txHash: tx("66") });
  v3Event("endorsements", "Endorsed", { id: "1", fromAgentId: "8", toAgentId: "7", capabilityId: tx("aa"), capability: "summarize", basis: "2", weight: "40", evidenceJobId: "0", evidenceAmountWei: "0", uri: "" }, { block: 401100, txHash: tx("65") });
  v3Event("endorsements", "Endorsed", { id: "2", fromAgentId: "8", toAgentId: "7", capabilityId: tx("ab"), capability: "translate", basis: "1", weight: "10", evidenceJobId: "2", evidenceAmountWei: "500000000000000000", uri: "" }, { block: 401200, txHash: tx("64") });
  v3Event("endorsements", "EndorsementRevoked", { id: "1", fromAgentId: "8", toAgentId: "7", weight: "40" }, { block: 401300, txHash: tx("63") });

  // 8 days of probe history so uptime stops being noise
  const day = 86_400_000;
  for (let d = 8; d >= 0; d--) {
    recordProbe(db, 7, true, 40, clock.ms() - d * day);
    if (d === 3) recordProbe(db, 7, false, 0, clock.ms() - d * day);
  }
  const up = agentUptime(db, 7, 30, clock.ms());
  assert.equal(up.enoughHistory, true);
  assert.equal(up.probes, 10);
  assert.equal(up.uptimePct, 90);

  const doc = (await get("/api/cv/7")).json();
  const anchor = doc.credentialSubject.record.find((c) => c.type === "MemoryAnchor");
  assert.equal(anchor.root, batch.root);
  assert.equal(anchor.anchorSeq, 1);
  assert.equal(anchor.evidence.trust, "chain");
  assert.equal(anchor.evidence.tx, tx("66"));
  assert.match(anchor.note, /not that the log is complete/);
  assert.ok(anchor.proofs.endsWith("/api/memory/proof/7/{seq}"));

  // a revoked endorsement leaves the record[] but stays in the counts
  const endorsements = doc.credentialSubject.record.filter((c) => c.type === "Endorsement");
  assert.equal(endorsements.length, 1);
  assert.equal(endorsements[0].capability, "translate");
  assert.equal(endorsements[0].paymentBacked, true);
  assert.equal(doc.credentialSubject.summary.endorsements.total, 2);
  assert.equal(doc.credentialSubject.summary.endorsements.revoked, 1);
  assert.equal(doc.credentialSubject.summary.endorsements.paymentBacked, 1);

  const reliability = doc.credentialSubject.record.find((c) => c.type === "Reliability");
  assert.equal(reliability.uptimePct, 90);
  assert.equal(reliability.evidence.provenance, "observed");
  assert.equal(reliability.evidence.proven, false);
  assert.match(reliability.evidence.note, /cannot re-derive|observed by this gateway/);

  const mem = doc.credentialSubject.summary.memory;
  assert.equal(mem.anchors, 1);
  assert.equal(mem.records, 1);
  assert.equal(mem.unanchored, 0);
  assert.equal(mem.latestRoot, batch.root);
  assert.equal(mem.keys, 1);
});

test("?limit caps record[] and declares exactly what it left out", async (t) => {
  const { app, get } = await setup();
  t.after(() => app.close());

  const full = (await get("/api/cv/7")).json();
  assert.equal(full.credentialSubject.recordMeta.complete, true);
  assert.deepEqual(full.credentialSubject.recordMeta.omitted, []);

  const capped = (await get("/api/cv/7?limit=3")).json();
  assert.equal(capped.credentialSubject.record.length, 3);
  assert.equal(capped.credentialSubject.recordMeta.complete, false);
  const dropped = capped.credentialSubject.recordMeta.omitted.reduce((a, o) => a + o.count, 0);
  assert.equal(dropped, full.credentialSubject.record.length - 3);
  for (const o of capped.credentialSubject.recordMeta.omitted) assert.ok(o.type && o.reason);
  // a different claim set is a different document, and the hashing rules say so
  assert.notEqual(capped.claimsRoot, full.claimsRoot);
  assert.match(capped.hashing.limitNote, /changes claimsRoot and documentHash/);
});

test("the anchor routes reserve their key names instead of shadowing a key silently", async (t) => {
  const { app, get, put, inject, signed, clock } = await setup();
  t.after(() => app.close());

  const reserved = await inject("PUT", "/api/memory/anchors", await signed(alice, "memory.put", { key: "anchors", value: { a: 1 } }));
  clock.advance(1500);
  assert.equal(reserved.statusCode, 409);
  assert.equal(reserved.json().code, "reserved_key");
  assert.match(reserved.json().error, /written but never read back/);

  const reserved2 = await inject("PUT", "/api/memory/proof", await signed(alice, "memory.put", { key: "proof", value: 1 }));
  clock.advance(1500);
  assert.equal(reserved2.statusCode, 409);

  // the suggested prefix works, and the ledger route is still the ledger
  assert.equal((await put("my.anchors", { a: 1 })).statusCode, 201);
  assert.equal((await get("/api/memory/anchors")).json().total, 0);
  assert.ok(Array.isArray((await get("/api/memory/anchors")).json().items));
});

test("GET /api/agents/:id gains a cv link block", async (t) => {
  const { app, get } = await setup();
  t.after(() => app.close());

  const a = (await get("/api/agents/7")).json();
  assert.equal(a.cv.document, "https://ferminux.net/api/cv/7");
  assert.equal(a.cv.credential, "https://ferminux.net/api/cv/7/credential.json");
  assert.equal(a.cv.verify, "https://ferminux.net/api/cv/7/verify");
  assert.equal(a.cv.badge, "https://ferminux.net/api/cv/7/badge.svg");
  assert.equal(a.cv.bySlug, "https://ferminux.net/api/cv/scribe-bot");
  assert.equal(a.cv.similar, "https://ferminux.net/api/network/similar/7");
  assert.match(a.cv.description, /without calling Ferminux/);
  assert.equal(a.links.cv, "https://ferminux.net/api/cv/7");
  assert.equal(a.links.credential, "https://ferminux.net/api/cv/7/credential.json");
});

test("the record routes are discoverable: openapi, route index, llms.txt, manifests", async (t) => {
  const { app, get } = await setup();
  t.after(() => app.close());

  const spec = (await get("/api/openapi.json")).json();
  for (const path of ["/api/cv/{agent}", "/api/cv/{agent}/credential.json", "/api/cv/{agent}/verify", "/api/cv/{agent}/badge.svg", "/api/network", "/api/network/similar/{agent}", "/api/memory/anchor", "/api/memory/anchors", "/api/memory/proof/{agentId}/{seq}"]) {
    assert.ok(spec.paths[path], `openapi missing ${path}`);
  }
  assert.equal(spec["x-ferminux-signing"].actions["POST /api/memory/anchor"], "memory.anchor (signed by the agent's owner)");
  assert.ok(spec["x-ferminux"].memoryAnchor);
  assert.ok(spec.tags.some((t2) => t2.name === "cv"));

  const index = (await get("/api")).json();
  assert.ok(index.routes.some((r) => r.path === "/api/cv/{agent}" && r.method === "GET"));
  assert.ok(index.routes.some((r) => r.path === "/api/network"));
  assert.equal(index.contracts.memoryAnchor, cfg.v3.memoryAnchor);

  const llms = (await get("/api/discovery/llms.txt")).body;
  for (const needle of ["/api/cv/", "credential.json", "/api/network", "/api/memory/anchor", "FRC-100"]) {
    assert.ok(llms.includes(needle), `llms.txt missing ${needle}`);
  }

  const manifest = (await get("/api/discovery/ferminux.json")).json();
  assert.ok(manifest.endpoints.cv.includes("/api/cv/"));
  assert.ok(manifest.endpoints.network.endsWith("/api/network"));
  assert.equal(manifest.contracts.memoryAnchor, cfg.v3.memoryAnchor);

  const card = (await get("/api/discovery/agent.json")).json();
  const skill = card.skills.find((s) => s.id === "record");
  assert.ok(skill, "network card has no `record` skill");
  assert.ok(skill.examples.some((e) => e.includes("/api/cv/")));
});
