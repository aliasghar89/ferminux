// AI-CV — credential verification.
//
// Everything here runs OFFLINE. The only I/O a verifier is allowed is an RPC,
// and every RPC in this file is a stub object, so a passing run proves the
// claim the design rests on: a stranger verifies a CV with the document and a
// public RPC, and no Ferminux service is reachable or needed. `globalThis.fetch`
// is replaced by a throwing stub around every verification, so any attempt to
// call a gateway would fail the test loudly rather than pass quietly.
import test from "node:test";
import assert from "node:assert/strict";
import {
  Interface,
  Wallet,
  getAddress,
  keccak256,
  toUtf8Bytes,
  TypedDataEncoder,
} from "ethers";
import {
  verifyCv,
  presentCv,
  cvLeaf,
  cvMerkleRoot,
  cvMerklePath,
  cvFoldPath,
  cvDocumentHash,
  cvDigest,
  cvDomain,
  didPkh,
  didPkhAddress,
  AGENT_CV_TYPES,
  CV_CONTEXT,
  CV_TYPE,
  CV_CRYPTOSUITE,
  REGISTRY_ABI,
  ESCROW_ABI,
  IDENTITY_8004_ABI,
  memoryLeaf,
  memoryRoot,
  memoryProof,
  memoryVerify,
} from "../dist/index.js";

const CHAIN_ID = 3961;
const REGISTRY = "0xa94f27F18267d09349809f3e2AeF8e7767033e8F";
const ESCROW = "0x99b331495951dB91857902de91EAe9Ff54d8a719";
const IDENTITY = "0xf3e8c83a0472602d04Cd774e3887cBAA76c62147";

// Hardhat account #0 / #1 — public test keys, never used on a live chain.
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const IMPOSTOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const registryIface = new Interface(REGISTRY_ABI);
const escrowIface = new Interface(ESCROW_ABI);
const identityIface = new Interface(IDENTITY_8004_ABI);

const TX_REG = "0x" + "11".repeat(32);
const TX_JOB = "0x" + "22".repeat(32);

// ---------------------------------------------------------------------------
// A stub RPC. Implements exactly the two methods a verifier uses.
// ---------------------------------------------------------------------------

function makeRpc({ owner, agentId = 1, jobs = {}, counters = {}, anchor = null, receipts = {} }) {
  const agent = {
    owner,
    name: "Toolbox",
    endpoint: "https://example.invalid/a/toolbox",
    metadataURI: "",
    pricePerJob: 100000000000000000n,
    bond: 100000000000000000000n,
    registeredAt: 1789938616n,
    retiredAt: 0n,
    status: 1,
    jobsCompleted: 2,
    jobsFailed: 0,
    ratingCount: 1,
    ratingSum: 5,
    ...counters,
  };
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async call({ to, data }) {
      calls++;
      const target = getAddress(to);
      if (target === getAddress(REGISTRY)) {
        const fn = registryIface.getFunction(data.slice(0, 10));
        assert.equal(fn.name, "getAgent");
        const [id] = registryIface.decodeFunctionData("getAgent", data);
        assert.equal(Number(id), agentId);
        return registryIface.encodeFunctionResult("getAgent", [
          [
            agent.owner,
            agent.name,
            agent.endpoint,
            agent.metadataURI,
            agent.pricePerJob,
            agent.bond,
            agent.registeredAt,
            agent.retiredAt,
            agent.status,
            agent.jobsCompleted,
            agent.jobsFailed,
            agent.ratingCount,
            agent.ratingSum,
          ],
        ]);
      }
      if (target === getAddress(ESCROW)) {
        const [id] = escrowIface.decodeFunctionData("getJob", data);
        const job = jobs[Number(id)];
        if (!job) throw new Error(`no job ${id}`);
        return escrowIface.encodeFunctionResult("getJob", [
          [job.agentId, job.client, job.amount, job.inputHash, job.outputHash, job.inputURI, job.outputURI, job.createdAt, job.deliveredAt, job.status],
        ]);
      }
      if (target === getAddress(IDENTITY)) {
        return identityIface.encodeFunctionResult("getMetadata", [anchor ?? "0x"]);
      }
      throw new Error(`stub RPC: unexpected call to ${to}`);
    },
    async getTransactionReceipt(hash) {
      calls++;
      return receipts[hash] ?? null;
    },
    async getCode() {
      return "0x";
    },
  };
}

/** Wraps a body so any HTTP call during it is a hard failure. */
async function offline(body) {
  const saved = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("a verifier must not contact any HTTP service — this call should never happen");
  };
  try {
    return await body();
  } finally {
    globalThis.fetch = saved;
  }
}

// ---------------------------------------------------------------------------
// Fixture: one CV with a Registration claim, one EscrowJob claim (log + call
// binds), and one self-attested Capability claim.
// ---------------------------------------------------------------------------

const JOB = {
  agentId: 1n,
  client: "0x6beE9D8F7f4B701d54dE273138F6994183707DD9",
  amount: 100000000000000000n,
  inputHash: "0x" + "aa".repeat(32),
  outputHash: "0x" + "bb".repeat(32),
  inputURI: "fmx://payload/0xaa",
  outputURI: "fmx://payload/0xbb",
  createdAt: 1789938900n,
  deliveredAt: 1789938950n,
  status: 3,
};

function registrationClaim(owner) {
  const event = "AgentRegistered(uint256,address,string,string,string,uint256,uint256)";
  return {
    id: "fmx:1:registration",
    type: "Registration",
    statedAt: "2026-09-20T21:10:16Z",
    agentId: 1,
    name: "Toolbox",
    // AS REGISTERED. The live endpoint / price / bond / status are mutable
    // registry state and live in the AgentState claim, which is read live.
    endpointAtRegistration: "https://example.invalid/a/toolbox",
    metadataURIAtRegistration: "",
    pricePerJobWeiAtRegistration: "100000000000000000",
    bondWeiAtRegistration: "100000000000000000000",
    evidence: {
      trust: "chain",
      chainId: CHAIN_ID,
      block: 349216,
      tx: TX_REG,
      logIndex: 0,
      blockLogIndex: 0,
      address: REGISTRY,
      event,
      topic0: keccak256(toUtf8Bytes(event)),
      method: "eth_getTransactionReceipt",
      bind: [
        { log: "id", equals: "subject.agentId" },
        { log: "owner", equals: "subject.address" },
      ],
    },
  };
}

function jobClaim() {
  const event = "JobCompleted(uint256,uint256,uint256,uint8)";
  return {
    id: "fmx:1:job:1",
    type: "EscrowJob",
    statedAt: "2026-09-20T21:15:52Z",
    jobId: 1,
    client: JOB.client,
    amountWei: "100000000000000000",
    payoutWei: "97500000000000000",
    feeWei: "2500000000000000",
    outcome: "Completed",
    // ServiceEscrow.claim() records rating 0 for an unreviewed job, so 0 means
    // UNRATED. The schema forbids coercing null to 0; the bind rule carries the
    // `|0` default so the log's 0 still binds.
    rating: null,
    ratingNote: "released without a rating (rating 0 = unrated)",
    outputHash: JOB.outputHash,
    evidence: {
      trust: "chain",
      chainId: CHAIN_ID,
      block: 349264,
      tx: TX_JOB,
      logIndex: 0,
      blockLogIndex: 0,
      address: ESCROW,
      event,
      topic0: keccak256(toUtf8Bytes(event)),
      method: "eth_getTransactionReceipt",
      bind: [
        { log: "jobId", equals: "claim.jobId" },
        { log: "rating", equals: "claim.rating|0" },
        { call: { address: ESCROW, fn: "getJob(uint256)", args: ["claim.jobId"], field: "agentId" }, equals: "subject.agentId" },
        { call: { address: ESCROW, fn: "getJob(uint256)", args: ["claim.jobId"], field: "outputHash" }, equals: "claim.outputHash" },
      ],
    },
  };
}

function capabilityClaim() {
  return {
    id: "fmx:1:capabilities",
    type: "Capability",
    statedAt: "2026-09-23T00:00:00Z",
    capabilities: ["hash", "encode", "json"],
    evidence: { trust: "selfAttested", note: "declared by the agent in its card; not proved by chain state" },
  };
}

/** The mutable half: no transaction, re-read from the registry by the verifier. */
function stateClaim(owner, over = {}) {
  return {
    id: "fmx:1:state",
    type: "AgentState",
    statedAt: "2026-09-23T00:00:00Z",
    agentId: 1,
    owner,
    endpoint: "https://example.invalid/a/toolbox",
    metadataURI: "",
    pricePerJobWei: "100000000000000000",
    bondWei: "100000000000000000000",
    status: "Active",
    ...over,
    evidence: { trust: "chain", chainId: CHAIN_ID, address: REGISTRY, method: "eth_call", call: "getAgent(1)" },
  };
}

function receipts(owner) {
  const regLog = registryIface.encodeEventLog("AgentRegistered", [1, owner, "Toolbox", "https://example.invalid/a/toolbox", "", 100000000000000000n, 100000000000000000000n]);
  const jobLog = escrowIface.encodeEventLog("JobCompleted", [1, 97500000000000000n, 2500000000000000n, 0]);
  return {
    [TX_REG]: { blockNumber: 349216, status: 1, logs: [{ address: REGISTRY, topics: regLog.topics, data: regLog.data, index: 0 }] },
    [TX_JOB]: { blockNumber: 349264, status: 1, logs: [{ address: ESCROW, topics: jobLog.topics, data: jobLog.data, index: 0 }] },
  };
}

/** Assembles and signs a CV. Everything here is local: no chain, no gateway. */
async function makeCv({ signerKey = OWNER_KEY, claims, summary, issuedAt = Math.floor(Date.now() / 1000) - 60, ttl = 90 * 86400, agentId = 1, registry = REGISTRY, subjectKey, topLevelDocumentHash = false } = {}) {
  const wallet = new Wallet(signerKey);
  // A gateway-issued CV is signed by the index but is ABOUT the owner, so the
  // signer and the subject are different keys.
  const subject = subjectKey ? new Wallet(subjectKey) : wallet;
  const record = claims ?? [registrationClaim(wallet.address), jobClaim(), capabilityClaim()];
  const leaves = record.map(cvLeaf);
  record.forEach((c, i) => {
    c.leaf = leaves[i];
  });
  const claimsRoot = cvMerkleRoot(leaves);
  const expiresAt = issuedAt + ttl;
  const uri = `https://example.invalid/cv/${agentId}.json`;
  const doc = {
    "@context": [...CV_CONTEXT],
    type: [...CV_TYPE],
    id: uri,
    issuer: didPkh(CHAIN_ID, wallet.address),
    validFrom: new Date(issuedAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    validUntil: new Date(expiresAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    credentialSubject: {
      id: didPkh(CHAIN_ID, subject.address),
      type: "AutonomousAgent",
      name: "Toolbox",
      agent: {
        chainId: CHAIN_ID,
        caip2: `eip155:${CHAIN_ID}`,
        agentId,
        agentRegistry: registry,
        identityRegistry: IDENTITY,
        controller: didPkh(CHAIN_ID, subject.address),
        identityKey: "agent.agentId",
      },
      summary: summary ?? { asOfBlock: 383565, jobsCompleted: 2, jobsFailed: 0, ratingCount: 1, ratingSum: 5 },
      record,
      recordMeta: { count: record.length, complete: false },
    },
  };
  // Every document the gateway serves carries its own documentHash at the top
  // level. `cvDocumentHash` must strip it, or the hash a reader recomputes can
  // never be the hash that was signed.
  const documentHash = cvDocumentHash(doc);
  if (topLevelDocumentHash) doc.documentHash = documentHash;
  const message = {
    chainId: CHAIN_ID,
    registry: getAddress(registry),
    agentId,
    subject: getAddress(subject.address),
    claimsRoot,
    documentHash,
    issuedAt,
    expiresAt,
    asOfBlock: 383565,
    asOfBlockHash: "0x" + "cc".repeat(32),
    uri,
  };
  const domain = cvDomain(CHAIN_ID, IDENTITY);
  doc.proof = {
    type: "DataIntegrityProof",
    cryptosuite: CV_CRYPTOSUITE,
    created: new Date(issuedAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    proofPurpose: "assertionMethod",
    verificationMethod: `${didPkh(CHAIN_ID, wallet.address)}#blockchainAccountId`,
    eip712: { domain: { name: domain.name, version: domain.version, chainId: CHAIN_ID, verifyingContract: getAddress(IDENTITY) }, primaryType: "AgentCV", types: AGENT_CV_TYPES, message },
    digest: cvDigest(domain, message),
    proofValue: await wallet.signTypedData(domain, AGENT_CV_TYPES, message),
  };
  return { doc, wallet, subject };
}

function rpcFor(wallet, extra = {}) {
  return makeRpc({ owner: wallet.address, jobs: { 1: JOB }, receipts: receipts(wallet.address), ...extra });
}

// ---------------------------------------------------------------------------
// 1. The hashing primitives, against the published reference document
// ---------------------------------------------------------------------------

test("cvLeaf reproduces the reference CV's registration leaf byte-for-byte", () => {
  // Taken verbatim from the AI-CV v1 worked example (agent #1, Toolbox, chain 3961).
  const claim = {
    id: "fmx:1:registration",
    type: "Registration",
    statedAt: "2026-09-20T21:10:16Z",
    agentId: 1,
    name: "Toolbox",
    endpoint: "https://ferminux.net/a/toolbox",
    pricePerJobWei: "100000000000000000",
    bondWei: "100000000000000000000",
    evidence: {
      trust: "chain",
      chainId: 3961,
      block: 349216,
      blockTime: "2026-09-20T21:10:16Z",
      tx: "0x64dc2668d06cd4a34d5527975298875454a871e1fad084ce18f7387047cd9013",
      logIndex: 0,
      address: "0xa94f27F18267d09349809f3e2AeF8e7767033e8F",
      event: "AgentRegistered(uint256,address,string,string,string,uint256,uint256)",
      topic0: "0x48a540e48c39d376aef6fe5e4f4ac018e6c8abad0344423e865bd5ae57c70881",
      method: "eth_getTransactionReceipt",
      bind: [
        { log: "id", equals: "subject.agentId" },
        { log: "owner", equals: "subject.address" },
      ],
    },
  };
  assert.equal(cvLeaf(claim), "0x96481e2e27067ba84ea2065473383d0d2c19ec18e15e3cbf45485007808472f0");
  // `leaf` and `path` are excluded from the hash, so adding them changes nothing.
  assert.equal(cvLeaf({ ...claim, leaf: "0xdead", path: ["R:0xbeef"] }), cvLeaf(claim));
});

test("cvMerkleRoot over the reference CV's 9 leaves is its signed claimsRoot", () => {
  const leaves = [
    "0x96481e2e27067ba84ea2065473383d0d2c19ec18e15e3cbf45485007808472f0",
    "0x96ec1310b8ac0d2456b1e3c9d5ec615afece65dea8d6061bc054854c27ead509",
    "0x6e55a379f0bfd74d26a1f80d5d3cfbdf56c8f1cbdc51a28812e5e63c2e99f4d0",
    "0x851e711a5369ec2f7e123aeeeaa5d5078517d7b6a087174f130de1a6d27f3e95",
    "0xc0f908b20934c7fd60be30e379b9020edee7d45d2c6cd9b038d14b8db7b4fdf6",
    "0x25737e2c338762507ca8ff9225720847f320f1cc9247d99448bbae53c935458d",
    "0xdd6c7c7eed9994283d2325d34bc8b1f3e9536e2768d6fd205ea23c09ae442b72",
    "0xb58ddcc2490316c5c5d75a5cf8a1ae6df7e4fc3250ffd21bb023916777fdcc58",
    "0xa49f68125e80baeacf57485f8016ba8a0451bf100cb6be684056843b5a431091",
  ];
  assert.equal(cvMerkleRoot(leaves), "0x38b458c622008ccd350bbfa7ed57d6f3cdb072d6bed7e7b94b367901f1221bb3");
});

test("the AgentCV EIP-712 domain separator and digest match the reference CV", () => {
  const domain = cvDomain(3961, IDENTITY);
  assert.equal(TypedDataEncoder.hashDomain(domain), "0x9100deaf5f5ae2b13398567196d1d92450d57ece2e43d59d13a6890f4607aacc");
  const message = {
    chainId: 3961,
    registry: REGISTRY,
    agentId: 1,
    subject: "0x4660E707371db34E8229A66b1e141053F61b2AD4",
    claimsRoot: "0x38b458c622008ccd350bbfa7ed57d6f3cdb072d6bed7e7b94b367901f1221bb3",
    documentHash: "0x809fdfdc3ff99e387d44b8707939943f7a404b6531cb5241b3583aaf3d7f8a59",
    issuedAt: 1790179200,
    expiresAt: 1797955200,
    asOfBlock: 383565,
    asOfBlockHash: "0xc751d4cbc85b45aeefc11cf56b88ece5996ffdb97b3548152e9cff05d65bac8a",
    uri: "https://ferminux.net/api/agents/1/cv.json",
  };
  assert.equal(cvDigest(domain, message), "0xe191eabce7bb60e308073607bc90618b9b5a1705b8f325ab592857f4418ac44f");
});

test("every merkle path folds back to the root, at every leaf count including odd ones", () => {
  for (let n = 1; n <= 12; n++) {
    const leaves = Array.from({ length: n }, (_, i) => keccak256(toUtf8Bytes(`leaf-${n}-${i}`)));
    const root = cvMerkleRoot(leaves);
    for (let i = 0; i < n; i++) {
      assert.equal(cvFoldPath(leaves[i], cvMerklePath(leaves, i)), root, `n=${n} i=${i}`);
    }
  }
});

test("did:pkh round-trips and rejects anything else", () => {
  const addr = "0x4660E707371db34E8229A66b1e141053F61b2AD4";
  assert.equal(didPkh(3961, addr), `did:pkh:eip155:3961:${addr}`);
  assert.deepEqual(didPkhAddress(`did:pkh:eip155:3961:${addr}#blockchainAccountId`), { chainId: 3961, address: addr });
  assert.equal(didPkhAddress("did:ethr:0x1234"), null);
  assert.equal(didPkhAddress("did:pkh:eip155:3961:not-an-address"), null);
});

// ---------------------------------------------------------------------------
// 2. A valid credential verifies with no Ferminux service reachable
// ---------------------------------------------------------------------------

test("a valid credential verifies against an RPC alone, with no Ferminux service reachable", async () => {
  const { doc, wallet } = await makeCv();
  const rpc = rpcFor(wallet);
  const res = await offline(() => verifyCv(doc, { provider: rpc }));
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.equal(res.offlineOk, true);
  assert.equal(res.chainChecked, true);
  assert.equal(res.signer, wallet.address);
  assert.equal(res.owner, wallet.address);
  assert.equal(res.verified, 2, "both chain claims bind");
  assert.equal(res.rejected, 0);
  assert.equal(res.skipped, 1, "the selfAttested Capability claim is below the chain floor");
  assert.equal(res.anchor, "unanchored");
  assert.deepEqual(
    res.steps.filter((s) => s.status === "fail").map((s) => s.name),
    [],
  );
  assert.ok(rpc.calls > 0, "the verifier really did read the chain");
});

test("steps 1-4 pass with no RPC at all, and the result says nothing was checked on chain", async () => {
  const { doc } = await makeCv();
  const res = await offline(() => verifyCv(doc, {}));
  assert.equal(res.offlineOk, true);
  assert.equal(res.chainChecked, false);
  assert.equal(res.ok, false, "internally consistent is not the same as verified");
  assert.ok(res.warnings.some((w) => w.includes("nothing was checked against the chain")));
});

test("a CV anchored on chain reports `current`; a newer anchor reports `superseded`", async () => {
  const { doc, wallet } = await makeCv();
  const hash = doc.proof.eip712.message.documentHash;
  const encode = (h, uri) => new Interface(["function f(bytes32 a, string b)"]).encodeFunctionData("f", [h, uri]).slice(10);
  const current = await offline(() => verifyCv(doc, { provider: rpcFor(wallet, { anchor: "0x" + encode(hash, "fmx://payload/x") }) }));
  assert.equal(current.anchor, "current");
  assert.equal(current.ok, true);

  const superseded = await offline(() => verifyCv(doc, { provider: rpcFor(wallet, { anchor: "0x" + encode("0x" + "99".repeat(32), "fmx://payload/y") }) }));
  assert.equal(superseded.anchor, "superseded");
  assert.ok(superseded.warnings.some((w) => w.includes("superseded")));

  const required = await offline(() => verifyCv(doc, { provider: rpcFor(wallet), requireAnchor: true }));
  assert.equal(required.ok, false, "requireAnchor rejects an unanchored CV");
});

// ---------------------------------------------------------------------------
// 3. Tampering — every one of these MUST fail
// ---------------------------------------------------------------------------

test("tampering with any field of the document fails at documentHash", async () => {
  const { doc, wallet } = await makeCv();
  const tampered = structuredClone(doc);
  tampered.credentialSubject.summary.jobsCompleted = 999;
  const res = await offline(() => verifyCv(tampered, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, false);
  const s2 = res.steps.find((s) => s.step === 2);
  assert.equal(s2.status, "fail");
  assert.ok(res.errors[0].includes("documentHash"));
});

test("rewriting a claim and its leaf still fails: the signed claimsRoot does not move", async () => {
  const { doc, wallet } = await makeCv();
  const tampered = structuredClone(doc);
  tampered.credentialSubject.record[1].payoutWei = "9999000000000000000";
  tampered.credentialSubject.record[1].leaf = cvLeaf({ ...tampered.credentialSubject.record[1], leaf: undefined });
  // …and re-point documentHash, which a forger would have to do next.
  tampered.proof.eip712.message.documentHash = cvDocumentHash(tampered);
  const res = await offline(() => verifyCv(tampered, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, false);
  // documentHash now matches, so it falls over one step later: either the root
  // or the signature, both of which the forger cannot reproduce.
  assert.ok(res.steps.some((s) => (s.step === 3 || s.step === 4) && s.status === "fail"), JSON.stringify(res.steps));
});

test("a flipped signature byte fails at the signature step", async () => {
  const { doc, wallet } = await makeCv();
  const tampered = structuredClone(doc);
  const sig = tampered.proof.proofValue;
  tampered.proof.proofValue = sig.slice(0, -2) + (sig.slice(-2) === "1b" ? "1c" : "1b");
  const res = await offline(() => verifyCv(tampered, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, false);
  assert.equal(res.steps.find((s) => s.step === 4).status, "fail");
});

test("FORGERY: a CV correctly signed by someone who does not own the agent fails at authority", async () => {
  // Steps 1-4 pass — the document is internally perfect and the signature is
  // genuine. Step 5 is what stops it: this key does not own agent #1.
  const { doc } = await makeCv({ signerKey: IMPOSTOR_KEY });
  const realOwner = new Wallet(OWNER_KEY);
  const rpc = makeRpc({ owner: realOwner.address, jobs: { 1: JOB }, receipts: receipts(realOwner.address) });
  const res = await offline(() => verifyCv(doc, { provider: rpc }));
  assert.equal(res.offlineOk, true, "the forgery is a well-formed, correctly signed document");
  assert.equal(res.ok, false);
  const s5 = res.steps.find((s) => s.step === 5);
  assert.equal(s5.status, "fail");
  assert.ok(res.errors.some((e) => e.includes("neither owns this agent nor is a known index")));
});

test("THEFT: pasting another agent's transactions into your own CV unbinds every chain claim", async () => {
  // Agent #12's owner copies agent #1's registration and job into its own CV and
  // signs it honestly. The transactions are real; the binding is what fails.
  const thief = new Wallet(IMPOSTOR_KEY);
  const victim = new Wallet(OWNER_KEY);
  const claims = [registrationClaim(victim.address), jobClaim(), capabilityClaim()];
  const { doc } = await makeCv({ signerKey: IMPOSTOR_KEY, claims, agentId: 12 });
  const rpc = makeRpc({ owner: thief.address, agentId: 12, jobs: { 1: JOB }, receipts: receipts(victim.address) });
  const res = await offline(() => verifyCv(doc, { provider: rpc }));
  assert.equal(res.ok, false);
  assert.equal(res.steps.find((s) => s.step === 5).status, "pass", "the thief genuinely owns agent #12");
  assert.equal(res.verified, 0);
  assert.equal(res.rejected, 2, "both stolen chain claims are rejected");
  for (const c of res.claims.filter((c) => c.status === "rejected")) {
    assert.ok(c.reason, `${c.id} should say why`);
  }
});

test("a CV naming an unknown AgentRegistry fails: an impostor cannot supply its own registry", async () => {
  const fake = "0x00000000000000000000000000000000DeaDBeef";
  const { doc, wallet } = await makeCv({ registry: fake });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, false);
  assert.equal(res.steps.find((s) => s.step === 5).status, "fail");
  assert.ok(res.errors.some((e) => e.includes("registry")));
});

test("an expired CV fails at the shape step, and one whose window has not opened too", async () => {
  const expired = await makeCv({ issuedAt: Math.floor(Date.now() / 1000) - 200 * 86400, ttl: 90 * 86400 });
  const res = await offline(() => verifyCv(expired.doc, { provider: rpcFor(expired.wallet) }));
  assert.equal(res.ok, false);
  assert.ok(res.errors.includes("expired"));

  const future = await makeCv({ issuedAt: Math.floor(Date.now() / 1000) + 86400 });
  const res2 = await offline(() => verifyCv(future.doc, { provider: rpcFor(future.wallet) }));
  assert.ok(res2.errors.includes("not yet valid"));
});

test("a summary claiming more than the registry's own counters fails the aggregate cross-check", async () => {
  const { doc, wallet } = await makeCv({ summary: { asOfBlock: 383565, jobsCompleted: 400, ratingCount: 400, ratingSum: 2000 } });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, false);
  assert.equal(res.steps.find((s) => s.step === 8).status, "fail");
  assert.ok(res.errors.some((e) => e.includes("do not survive the registry's own counters")));
});

test("a claim with no bind rule of its own is still bound — by the VERIFIER's rule, not the document's", async () => {
  // The document no longer decides what gets checked. Stripping evidence.bind
  // removes a courtesy, not the gate: the verifier applies its own subject rule
  // for (Registration, AgentRegistered) and the claim still binds.
  const claim = registrationClaim(new Wallet(OWNER_KEY).address);
  delete claim.evidence.bind;
  const { doc, wallet } = await makeCv({ claims: [claim, capabilityClaim()] });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.claims[0].status, "verified");

  // And the same claim pointed at another agent's id fails on that same rule,
  // with no help from the document at all.
  const stolen = registrationClaim(new Wallet(OWNER_KEY).address);
  delete stolen.evidence.bind;
  const other = await makeCv({ claims: [stolen], agentId: 7 });
  const rpc7 = makeRpc({ owner: other.wallet.address, agentId: 7, jobs: { 1: JOB }, receipts: receipts(new Wallet(OWNER_KEY).address) });
  const res2 = await offline(() => verifyCv(other.doc, { provider: rpc7 }));
  assert.equal(res2.claims[0].status, "rejected");
  assert.match(res2.claims[0].reason, /not this agent's/);
});

test("a claim citing a transaction the RPC does not have is rejected, not silently accepted", async () => {
  const claim = registrationClaim(new Wallet(OWNER_KEY).address);
  claim.evidence.tx = "0x" + "77".repeat(32);
  const { doc, wallet } = await makeCv({ claims: [claim] });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, false);
  assert.ok(res.claims[0].reason.includes("not found"));
});

test("a claim whose topic0 does not hash its declared event is rejected", async () => {
  const claim = registrationClaim(new Wallet(OWNER_KEY).address);
  claim.evidence.topic0 = keccak256(toUtf8Bytes("SomethingElse(uint256)"));
  const { doc, wallet } = await makeCv({ claims: [claim] });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, false);
  assert.equal(res.claims[0].status, "rejected");
});

// ---------------------------------------------------------------------------
// 4. Trust floor and selective disclosure
// ---------------------------------------------------------------------------

test("the trust floor decides what is read, and selfAttested claims never count as verified", async () => {
  const { doc, wallet } = await makeCv();
  const strict = await offline(() => verifyCv(doc, { provider: rpcFor(wallet), trustFloor: "chain" }));
  assert.equal(strict.skipped, 1);
  const loose = await offline(() => verifyCv(doc, { provider: rpcFor(wallet), trustFloor: "selfAttested" }));
  assert.equal(loose.verified, 2, "a lower floor still does not promote a self-attested claim to verified");
  assert.equal(loose.claims.find((c) => c.trust === "selfAttested").status, "skipped");
});

test("a 1-of-3 presentation keeps the same signature and folds to the same signed root", async () => {
  const { doc, wallet } = await makeCv();
  const signedRoot = doc.proof.eip712.message.claimsRoot;
  const presentation = presentCv(doc, ["fmx:1:job:1"]);
  assert.equal(presentation.credentialSubject.record.length, 1);
  assert.equal(presentation.proof.proofValue, doc.proof.proofValue, "the signature is untouched");
  assert.equal(cvFoldPath(presentation.credentialSubject.record[0].leaf, presentation.credentialSubject.record[0].path), signedRoot);
  assert.equal(presentation.credentialSubject.recordMeta.omitted.reduce((n, o) => n + o.count, 0), 2, "what was dropped is declared");

  const res = await offline(() => verifyCv(presentation, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.equal(res.verified, 1);
  assert.equal(res.steps.find((s) => s.step === 3).status, "pass");
});

test("a presentation with a doctored merkle path does not verify", async () => {
  const { doc, wallet } = await makeCv();
  const presentation = presentCv(doc, ["fmx:1:job:1"]);
  presentation.credentialSubject.record[0].path = ["R:" + "0x" + "00".repeat(32)];
  const res = await offline(() => verifyCv(presentation, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, false);
  assert.equal(res.steps.find((s) => s.step === 3).status, "fail");
});

test("presentCv refuses to invent a claim that is not in the CV", async () => {
  const { doc } = await makeCv();
  assert.throws(() => presentCv(doc, ["fmx:1:job:404"]), /no such claim/);
});

// ---------------------------------------------------------------------------
// 5. FRC-100 memory anchoring — the same verifier the contract runs
// ---------------------------------------------------------------------------

test("a memory proof folds to its anchored root, at every batch size including odd ones", () => {
  for (let n = 1; n <= 9; n++) {
    const leaves = Array.from({ length: n }, (_, i) => memoryLeaf(keccak256(toUtf8Bytes(`record-${n}-${i}`))));
    const root = memoryRoot(leaves);
    for (let i = 0; i < n; i++) {
      assert.equal(memoryVerify(root, leaves[i], memoryProof(leaves, i), i, n), true, `n=${n} i=${i}`);
    }
  }
});

test("a memory proof with the wrong leaf, a padded path or a wrong count is rejected", () => {
  const leaves = Array.from({ length: 5 }, (_, i) => memoryLeaf(keccak256(toUtf8Bytes(`r${i}`))));
  const root = memoryRoot(leaves);
  const proof = memoryProof(leaves, 2);
  assert.equal(memoryVerify(root, leaves[3], proof, 2, 5), false, "wrong leaf");
  assert.equal(memoryVerify(root, leaves[2], [...proof, leaves[0]], 2, 5), false, "leftover proof elements are a forgery attempt");
  assert.equal(memoryVerify(root, leaves[2], proof, 2, 4), false, "the count pins the tree shape");
  assert.equal(memoryVerify("0x" + "00".repeat(32), leaves[2], proof, 2, 5), false, "the zero root is never valid");
  assert.equal(memoryVerify(root, leaves[2], proof, 2, 5), true);
});

test("the memory tree is domain-tagged and is NOT the CV tree — the two never interchange", () => {
  const h = keccak256(toUtf8Bytes("x"));
  assert.notEqual(memoryLeaf(h), h, "a memory leaf carries the 0x00 tag");
  const three = [h, h, h];
  assert.notEqual(memoryRoot(three.map(memoryLeaf)), cvMerkleRoot(three));
});

test("a derived presentation cannot be re-pointed at another agent or owner", async () => {
  const { doc, wallet } = await makeCv();
  // The signature survives a subset (that is the point), so the body's identity
  // fields must be pinned to the signed message or a presentation becomes a
  // blank cheque.
  const repointed = presentCv(doc, ["fmx:1:job:1"]);
  repointed.credentialSubject.agent.agentId = 12;
  const res = await offline(() => verifyCv(repointed, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("agentId mismatch")));

  const reowned = presentCv(doc, ["fmx:1:job:1"]);
  reowned.credentialSubject.id = didPkh(CHAIN_ID, new Wallet(IMPOSTOR_KEY).address);
  const res2 = await offline(() => verifyCv(reowned, { provider: rpcFor(wallet) }));
  assert.equal(res2.ok, false);
  assert.ok(res2.errors.some((e) => e.includes("subject mismatch")));
});

test("a derived presentation whose summary was inflated is caught by the registry cross-check", async () => {
  const { doc, wallet } = await makeCv();
  const inflated = presentCv(doc, ["fmx:1:job:1"]);
  inflated.credentialSubject.summary.jobsCompleted = 500;
  const res = await offline(() => verifyCv(inflated, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, false);
  assert.equal(res.steps.find((s) => s.step === 8).status, "fail");
});

test("an UNSIGNED index still verifies its claims against the chain, and says so", async () => {
  // fmx.cv.build() produces this: a CV assembled from chain logs that nobody has
  // signed. Every claim is still provable; what is missing is only the issuer's
  // statement that it chose this set.
  const { doc, wallet } = await makeCv();
  const unsigned = structuredClone(doc);
  delete unsigned.proof;
  const res = await offline(() => verifyCv(unsigned, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.equal(res.signed, false);
  assert.equal(res.signer, null);
  assert.equal(res.owner, wallet.address);
  assert.equal(res.verified, 2);
  assert.ok(res.warnings.some((w) => w.includes("unsigned index")));
  for (const n of [2, 3, 4]) assert.equal(res.steps.find((s) => s.step === n).status, "skip");
});

test("an unsigned index naming the wrong owner is rejected — the registry wins", async () => {
  const { doc, wallet } = await makeCv();
  const unsigned = structuredClone(doc);
  delete unsigned.proof;
  unsigned.credentialSubject.id = didPkh(CHAIN_ID, new Wallet(IMPOSTOR_KEY).address);
  unsigned.credentialSubject.agent.controller = unsigned.credentialSubject.id;
  const res = await offline(() => verifyCv(unsigned, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("wrong owner")));
});

test("an unsigned index cannot bind claims to an address of its own choosing", async () => {
  // The bind rules resolve `subject.address` from the REGISTRY, not from the
  // document, so re-pointing the body at another owner cannot make a stolen
  // claim bind.
  const thief = new Wallet(IMPOSTOR_KEY);
  const { doc } = await makeCv({ signerKey: IMPOSTOR_KEY, claims: [registrationClaim(new Wallet(OWNER_KEY).address)], agentId: 12 });
  const unsigned = structuredClone(doc);
  delete unsigned.proof;
  const rpc = makeRpc({ owner: thief.address, agentId: 12, receipts: receipts(new Wallet(OWNER_KEY).address) });
  const res = await offline(() => verifyCv(unsigned, { provider: rpc }));
  assert.equal(res.ok, false);
  assert.equal(res.rejected, 1);
});

// ---------------------------------------------------------------------------
// 6. fmx.cv.sign() — the real signing path, round-tripped through the verifier
// ---------------------------------------------------------------------------

/** A Ferminux client with a key and no network use: sign() touches neither. */
async function signerClient(key = OWNER_KEY) {
  const { Ferminux } = await import("../dist/index.js");
  return new Ferminux({ privateKey: key, rpc: "http://127.0.0.1:1/unused", gateway: "http://127.0.0.1:1/unused" });
}

function unsignedDoc(wallet, agentId = 1) {
  const subject = wallet;
  const record = [registrationClaim(wallet.address), jobClaim(), capabilityClaim()];
  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  return {
    "@context": [...CV_CONTEXT],
    type: [...CV_TYPE],
    id: `https://example.invalid/cv/${agentId}.json`,
    issuer: didPkh(CHAIN_ID, wallet.address),
    validFrom: new Date(issuedAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    validUntil: new Date((issuedAt + 90 * 86400) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    credentialSubject: {
      id: didPkh(CHAIN_ID, subject.address),
      type: "AutonomousAgent",
      name: "Toolbox",
      agent: {
        chainId: CHAIN_ID,
        caip2: `eip155:${CHAIN_ID}`,
        agentId,
        agentRegistry: REGISTRY,
        identityRegistry: IDENTITY,
        controller: didPkh(CHAIN_ID, wallet.address),
      },
      summary: { asOfBlock: 383565, jobsCompleted: 2, jobsFailed: 0, ratingCount: 1, ratingSum: 5 },
      record,
      recordMeta: { count: record.length, complete: false },
    },
    evidence: [{ type: ["FerminuxChainAnchor"], chainId: CHAIN_ID, asOfBlock: 383565, asOfBlockHash: "0x" + "cc".repeat(32) }],
  };
}

test("fmx.cv.sign() produces a document its own verifier accepts, offline", async () => {
  const wallet = new Wallet(OWNER_KEY);
  const fmx = await signerClient();
  const signed = await offline(() => fmx.cv.sign(unsignedDoc(wallet)));
  assert.equal(signed.proof.cryptosuite, CV_CRYPTOSUITE);
  assert.equal(signed.proof.eip712.primaryType, "AgentCV");
  // sign() recomputes both hashes over the document as it stands: never a cache.
  assert.equal(cvDocumentHash(signed), signed.proof.eip712.message.documentHash);
  assert.equal(cvMerkleRoot(signed.credentialSubject.record.map(cvLeaf)), signed.proof.eip712.message.claimsRoot);
  assert.equal(signed.proof.digest, cvDigest(cvDomain(CHAIN_ID, IDENTITY), signed.proof.eip712.message));

  const res = await offline(() => verifyCv(signed, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.equal(res.signed, true);
  assert.equal(res.signer, wallet.address);
  assert.equal(res.verified, 2);
});

test("fmx.cv.sign() refuses to sign a CV that belongs to someone else", async () => {
  const owner = new Wallet(OWNER_KEY);
  const fmx = await signerClient(IMPOSTOR_KEY);
  await assert.rejects(() => fmx.cv.sign(unsignedDoc(owner)), /only the agent's owner key can sign it/);
});

test("a signed CV whose claims were edited afterwards is caught before it can be anchored", async () => {
  const wallet = new Wallet(OWNER_KEY);
  const fmx = await signerClient();
  const signed = await offline(() => fmx.cv.sign(unsignedDoc(wallet)));
  signed.credentialSubject.summary.jobsCompleted = 99;
  await assert.rejects(() => fmx.cv.anchor(signed), /changed after signing/);
});

// ---------------------------------------------------------------------------
// 7. The 1 gwei floor, on the transactions this layer adds
//
// Chain-3961 signers enforce a 1 gwei priority-fee floor while the base fee sits
// at a few wei. A transaction that follows the raw fee-history suggestion (often
// 1 wei) is accepted by the RPC node and then never confirmed. Every write here
// — setMetadata for a CV anchor, MemoryAnchor.anchor, Endorsements.endorse —
// goes through `fmx.runner`, so one check over the runner covers all three.
// ---------------------------------------------------------------------------

test("every contract write this layer sends floors the priority fee at 1 gwei", async () => {
  const { Ferminux, MIN_PRIORITY_FEE } = await import("../dist/index.js");
  const fmx = new Ferminux({ privateKey: OWNER_KEY, rpc: "http://127.0.0.1:1/unused" });
  const signer = fmx.requireSigner();
  assert.equal(fmx.runner, signer, "contract writes are bound to the signer, not the bare provider");

  // Base fee of 7 wei and a 1 wei fee-history suggestion: exactly the shape that
  // produces a transaction the node accepts and the signers never confirm.
  const provider = signer.provider;
  provider.getFeeData = async () => ({ maxPriorityFeePerGas: 1n, maxFeePerGas: 9n, gasPrice: 9n });
  provider.getBlock = async () => ({ baseFeePerGas: 7n });
  provider.getNetwork = async () => ({ chainId: BigInt(CHAIN_ID), name: "ferminux" });
  provider.getTransactionCount = async () => 0;
  provider.estimateGas = async () => 100000n;

  const populated = await signer.populateTransaction({ to: IDENTITY, data: "0x", from: signer.address, chainId: CHAIN_ID, nonce: 0, gasLimit: 100000n, type: 2 });
  assert.equal(populated.maxPriorityFeePerGas, MIN_PRIORITY_FEE, "the 1 wei suggestion must be floored to 1 gwei");
  assert.ok(populated.maxFeePerGas >= MIN_PRIORITY_FEE);

  // An explicit fee is never overridden.
  const explicit = await signer.populateTransaction({ to: IDENTITY, data: "0x", from: signer.address, chainId: CHAIN_ID, nonce: 0, gasLimit: 100000n, type: 2, maxPriorityFeePerGas: 5_000_000_000n, maxFeePerGas: 6_000_000_000n });
  assert.equal(explicit.maxPriorityFeePerGas, 5_000_000_000n);
});

test("an unsigned index can be narrowed too, and its claims still verify one by one", async () => {
  const { doc, wallet } = await makeCv();
  const unsigned = structuredClone(doc);
  delete unsigned.proof;
  const narrowed = presentCv(unsigned, ["fmx:1:job:1"]);
  assert.equal(narrowed.credentialSubject.record.length, 1);
  assert.equal(narrowed.derivedFrom.documentHash, undefined, "there was no signed documentHash to point at");
  assert.match(narrowed.derivedFrom.note, /UNSIGNED/);
  const res = await offline(() => verifyCv(narrowed, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, true, res.errors.join("; "));
  assert.equal(res.signed, false);
  assert.equal(res.verified, 1);
});

// ---------------------------------------------------------------------------
// 9. The attacks that worked, one test each.
//
// Every test below reproduces a forgery that PASSED the shipped verifier, or a
// genuine document the shipped verifier REFUSED. They are written from the
// attacker's side: the document is well-formed, correctly signed by a key that
// really does own the agent, and every transaction it cites is real. What
// changed is that the verifier stopped letting the document choose what got
// checked.
// ---------------------------------------------------------------------------

const FAKE_ESCROW = "0x00000000000000000000000000000000FaceB00c";

test("BREAK #1: a claim citing an attacker's own contract is rejected, however genuine its topic0", async () => {
  // The full break. Deploy a contract, emit a log carrying the real
  // JobCompleted topic0 (it decodes cleanly with the verifier's own ABI), point
  // the claim and its bind.call.address at that contract, and getJob(9000)
  // answers with your own agent id. Every bind used to pass. 58,500 FMX.
  const owner = new Wallet(OWNER_KEY);
  const claim = jobClaim();
  claim.jobId = 9000;
  claim.payoutWei = "58500000000000000000000";
  claim.evidence.address = FAKE_ESCROW;
  claim.evidence.bind = [
    { log: "jobId", equals: "claim.jobId" },
    { call: { address: FAKE_ESCROW, fn: "getJob(uint256)", args: ["claim.jobId"], field: "agentId" }, equals: "subject.agentId" },
  ];
  const fakeLog = escrowIface.encodeEventLog("JobCompleted", [9000, 58500000000000000000000n, 0n, 5]);
  const { doc, wallet } = await makeCv({ claims: [claim] });
  const rpc = makeRpc({
    owner: wallet.address,
    jobs: { 9000: { ...JOB, agentId: 1n } },
    receipts: { [TX_JOB]: { blockNumber: 349264, status: 1, logs: [{ address: FAKE_ESCROW, topics: fakeLog.topics, data: fakeLog.data, index: 0 }] } },
  });
  const res = await offline(() => verifyCv(doc, { provider: rpc }));
  assert.equal(res.ok, false);
  assert.equal(res.verified, 0);
  assert.equal(res.claims[0].status, "rejected");
  assert.match(res.claims[0].reason, /not a contract this verifier knows/);
  assert.equal(res.verifiedEarned.escrowEarnedWei, "0", "nothing this claim stated reached the money figure");
});

test("BREAK #1b: even with the log from the real escrow, a bind pointed at a foreign contract is refused", async () => {
  const claim = jobClaim();
  claim.evidence.bind = [{ call: { address: FAKE_ESCROW, fn: "getJob(uint256)", args: ["claim.jobId"], field: "agentId" }, equals: "subject.agentId" }];
  const { doc, wallet } = await makeCv({ claims: [claim] });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.claims[0].status, "rejected");
  assert.match(res.claims[0].reason, /may not supply the contract that answers for it/);
});

test("BREAK #2: a payout multiplied by 100 inside a proven claim is rejected", async () => {
  // The log says 0.0975 FMX. The claim says 9.75. Both are in the same
  // transaction; the old bind set covered {jobId, agentId, outputHash} and
  // never looked at agentPayout.
  const claim = jobClaim();
  claim.payoutWei = "9750000000000000000";
  const { doc, wallet } = await makeCv({ claims: [claim] });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, false);
  assert.equal(res.claims[0].status, "rejected");
  assert.match(res.claims[0].reason, /payoutWei = 9750000000000000000, the log records agentPayout = 97500000000000000/);
});

test("BREAK #2b: an unrated job turned into five stars is rejected", async () => {
  const claim = jobClaim();
  claim.rating = 5;
  const { doc, wallet } = await makeCv({ claims: [claim] });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.claims[0].status, "rejected");
  assert.match(res.claims[0].reason, /rating = 5, the log records rating = 0/);
});

test("BREAK #2c: a fee rewritten to zero is rejected", async () => {
  const claim = jobClaim();
  claim.feeWei = "0";
  const { doc, wallet } = await makeCv({ claims: [claim] });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.claims[0].status, "rejected");
});

test("BREAK #3: a rewritten endpoint, a Paused→Active flip and a 10x price all fail against live state", async () => {
  const owner = new Wallet(OWNER_KEY);
  for (const [field, value, needle] of [
    ["endpoint", "https://impostor.example/a/toolbox", /endpoint/],
    ["pricePerJobWei", "1000000000000000000", /pricePerJob/],
    ["bondWei", "1", /bond/],
  ]) {
    const claim = stateClaim(owner.address, { [field]: value });
    const { doc, wallet } = await makeCv({ claims: [claim] });
    const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
    assert.equal(res.claims[0].status, "rejected", `${field} should not pass`);
    assert.match(res.claims[0].reason, needle);
    assert.match(res.claims[0].reason, /stale or forged/);
  }
  // status: the registry says Active; a claim saying Paused (or the reverse) fails.
  const paused = stateClaim(owner.address, { status: "Paused" });
  const { doc, wallet } = await makeCv({ claims: [paused] });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.claims[0].status, "rejected");
  assert.match(res.claims[0].reason, /status is Active, the claim states Paused/);
});

test("BREAK #3b: honest live state verifies, so the rule is a check and not a blanket refusal", async () => {
  const owner = new Wallet(OWNER_KEY);
  const { doc, wallet } = await makeCv({ claims: [stateClaim(owner.address)] });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.claims[0].status, "verified");
});

test("BREAK #3c: mutable state smuggled back into a Registration claim is refused outright", async () => {
  const claim = registrationClaim(new Wallet(OWNER_KEY).address);
  claim.endpoint = "https://impostor.example/a/toolbox";
  const { doc, wallet } = await makeCv({ claims: [claim] });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.claims[0].status, "rejected");
  assert.match(res.claims[0].reason, /may not carry "endpoint"/);
});

test("BREAK #4: understating failures fails — step 8 runs in both directions", async () => {
  const { doc, wallet } = await makeCv({ summary: { asOfBlock: 383565, jobsCompleted: 2, jobsFailed: 0, ratingCount: 1, ratingSum: 5 } });
  const rpc = rpcFor(wallet, { counters: { jobsFailed: 6 } });
  const res = await offline(() => verifyCv(doc, { provider: rpc }));
  assert.equal(res.ok, false);
  assert.equal(res.steps.find((s) => s.step === 8).status, "fail");
  assert.match(res.steps.find((s) => s.step === 8).detail, /may not understate its failures/);
});

test("BREAK #5: an inflated escrowEarnedWei fails, because the money is recomputed from verified claims", async () => {
  // AgentRegistry keeps no earnings counter, so before this nothing at all
  // bounded this number — and it is the number a hiring agent reads.
  const { doc, wallet } = await makeCv({
    summary: { asOfBlock: 383565, jobsCompleted: 2, jobsFailed: 0, ratingCount: 1, ratingSum: 5, escrowEarnedWei: "58500000000000000000000" },
  });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.ok, false);
  assert.equal(res.steps.find((s) => s.step === 8).status, "fail");
  assert.match(res.steps.find((s) => s.step === 8).detail, /may not exceed what was proved/);
  assert.equal(res.verifiedEarned.escrowEarnedWei, "97500000000000000");
});

test("an honest escrowEarnedWei passes and is reported back as the verified figure", async () => {
  const { doc, wallet } = await makeCv({
    summary: { asOfBlock: 383565, jobsCompleted: 2, jobsFailed: 0, ratingCount: 1, ratingSum: 5, escrowEarnedWei: "97500000000000000" },
  });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.steps.find((s) => s.step === 8).status, "pass");
  assert.equal(res.verifiedEarned.escrowEarnedWei, "97500000000000000");
  assert.equal(res.verifiedEarned.paidJobs, 1);
  assert.equal(res.verifiedEarned.payers, 1);
});

test("zero-value jobs are counted and called out, never folded into the paid ones", async () => {
  const free = jobClaim();
  free.jobId = 2;
  free.amountWei = "0";
  free.payoutWei = "0";
  free.feeWei = "0";
  free.evidence.tx = "0x" + "33".repeat(32);
  free.evidence.block = 349300;
  const zeroLog = escrowIface.encodeEventLog("JobCompleted", [2, 0n, 0n, 5]);
  free.rating = 5;
  const { doc, wallet } = await makeCv({ claims: [free] });
  const rpc = makeRpc({
    owner: wallet.address,
    jobs: { 2: { ...JOB, agentId: 1n, amount: 0n } },
    receipts: { ["0x" + "33".repeat(32)]: { blockNumber: 349300, status: 1, logs: [{ address: ESCROW, topics: zeroLog.topics, data: zeroLog.data, index: 0 }] } },
  });
  const res = await offline(() => verifyCv(doc, { provider: rpc }));
  assert.equal(res.claims[0].status, "verified", "the job is real; it is just worth nothing");
  assert.equal(res.verifiedEarned.zeroValueJobs, 1);
  assert.equal(res.verifiedEarned.paidJobs, 0);
  assert.equal(res.verifiedEarned.payers, 0, "a payer who paid nothing is not a payer");
  assert.ok(res.warnings.some((w) => w.includes("moved 0 FMX")));
});

test("BREAK #6: the genuine gateway credential verifies — documentHash strips `documentHash` too", async () => {
  // The shipped verifier refused every document ferminux.net serves, because it
  // hashed the top-level `documentHash` into the digest it compared against.
  const { doc, wallet } = await makeCv({ topLevelDocumentHash: true });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.steps.find((s) => s.step === 2).status, "pass");
  assert.equal(res.documentHash, doc.documentHash);
  assert.equal(res.ok, true);
});

test("BREAK #7: an index-signed CV verifies as `indexer` when the key is PINNED, and never otherwise", async () => {
  const gateway = Wallet.createRandom();
  const { doc, subject } = await makeCv({ signerKey: gateway.privateKey, subjectKey: OWNER_KEY, topLevelDocumentHash: true });
  const rpc = makeRpc({ owner: subject.address, jobs: { 1: JOB }, receipts: receipts(subject.address) });

  const pinned = await offline(() => verifyCv(doc, { provider: rpc, issuers: [gateway.address] }));
  assert.equal(pinned.ok, true, "a gateway-issued credential is a legitimate artefact");
  assert.equal(pinned.issuerRole, "indexer");
  assert.ok(pinned.warnings.some((w) => w.includes("index-issued")));

  const unpinned = await offline(() => verifyCv(doc, { provider: rpc }));
  assert.equal(unpinned.ok, false, "an issuer key you did not pin in advance speaks for nobody");
  assert.match(unpinned.errors.join(" "), /neither owns this agent nor is a known index/);

  const strict = await offline(() => verifyCv(doc, { provider: rpc, issuers: [gateway.address], requireOwnerSigned: true }));
  assert.equal(strict.ok, false, "requireOwnerSigned demands the agent's own key");
});

test("a self-issued CV reports issuerRole `owner`", async () => {
  const { doc, wallet } = await makeCv({ topLevelDocumentHash: true });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.issuerRole, "owner");
});

test("a claim type this verifier has no rule for is skipped, never counted as proved", async () => {
  const claim = jobClaim();
  claim.type = "QuantumJob2031";
  const { doc, wallet } = await makeCv({ claims: [claim] });
  const res = await offline(() => verifyCv(doc, { provider: rpcFor(wallet) }));
  assert.equal(res.verified, 0);
  assert.equal(res.rejected, 0, "an unknown type is not a forgery");
  assert.equal(res.skipped, 1);
  assert.match(res.claims[0].reason, /no rule for a QuantumJob2031 claim/);
});

test("a reverted transaction proves nothing", async () => {
  const { doc, wallet } = await makeCv({ claims: [jobClaim()] });
  const rpc = makeRpc({
    owner: wallet.address,
    jobs: { 1: JOB },
    receipts: { ...receipts(wallet.address), [TX_JOB]: { ...receipts(wallet.address)[TX_JOB], status: 0 } },
  });
  const res = await offline(() => verifyCv(doc, { provider: rpc }));
  assert.equal(res.claims[0].status, "rejected");
  assert.match(res.claims[0].reason, /reverted/);
});

test("the block-scoped log index finds the right log when a block holds two transactions", async () => {
  // On 3961 today almost every block holds one transaction, so a receipt-scoped
  // index and a block-scoped one coincide. The first block that holds two is
  // where a reader guessing between them gets a different answer, so the field
  // says which it is.
  const claim = jobClaim();
  claim.evidence.blockLogIndex = 3;
  delete claim.evidence.logIndex;
  const jobLog = escrowIface.encodeEventLog("JobCompleted", [1, 97500000000000000n, 2500000000000000n, 0]);
  const decoy = escrowIface.encodeEventLog("JobCompleted", [4242, 1n, 0n, 5]);
  const { doc, wallet } = await makeCv({ claims: [claim] });
  const rpc = makeRpc({
    owner: wallet.address,
    jobs: { 1: JOB },
    receipts: {
      [TX_JOB]: {
        blockNumber: 349264,
        status: 1,
        logs: [
          { address: ESCROW, topics: decoy.topics, data: decoy.data, index: 2 },
          { address: ESCROW, topics: jobLog.topics, data: jobLog.data, index: 3 },
        ],
      },
    },
  });
  const res = await offline(() => verifyCv(doc, { provider: rpc }));
  assert.equal(res.claims[0].status, "verified");
});
