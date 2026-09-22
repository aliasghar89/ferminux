// Addendum v3 EIP-712 tests: X402Vault Voucher hashing/signing and
// AgentAccount executeWithSig digest hashing/signing (sdk/src/sign.ts).
// Each hash/signature is checked against an INDEPENDENT computation (the
// domain/types are redefined here from SPEC.md's prose, not imported from
// sign.ts) so a mistake in the shipped domain/type constants would fail this
// test even though the shipped functions would still agree with themselves.
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, TypedDataEncoder, keccak256, verifyTypedData } from "ethers";
import {
  x402Domain,
  hashVoucher,
  signVoucher,
  verifyVoucherSig,
  agentAccountDomain,
  hashExecute,
  signExecute,
  verifyExecuteSig,
  X402_DOMAIN_NAME,
  X402_DOMAIN_VERSION,
  AGENT_ACCOUNT_DOMAIN_NAME,
  AGENT_ACCOUNT_DOMAIN_VERSION,
} from "../dist/sign.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const CHAIN_ID = 3961;
const VAULT = "0x00000000000000000000000000000000000A11CE"; // stand-in X402Vault address
const ACCOUNT = "0x000000000000000000000000000000000ACC0757"; // stand-in AgentAccount address

test("X402_DOMAIN matches SPEC.md's binding domain literally", () => {
  assert.equal(X402_DOMAIN_NAME, "FerminuxX402");
  assert.equal(X402_DOMAIN_VERSION, "1");
});

test("hashVoucher matches an independently-built EIP-712 digest (domain + Voucher struct from SPEC.md '## C1')", async () => {
  const w = new Wallet(KEY);
  const voucher = {
    payer: w.address,
    payee: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    amount: 1_000_000_000_000_000_000n, // 1 FMX
    nonce: 42n,
    expiry: 1_900_000_000n,
    ref: keccak256(new TextEncoder().encode("fmx://payload/deadbeef")),
  };

  // Independently reconstructed domain/type — must match SPEC.md's prose exactly:
  // "EIP-712 typed data domain {name:"FerminuxX402", version:"1", chainId:3961, verifyingContract}"
  // struct Voucher { address payer; address payee; uint256 amount; uint256 nonce; uint64 expiry; bytes32 ref; }
  const domain = { name: "FerminuxX402", version: "1", chainId: CHAIN_ID, verifyingContract: VAULT };
  const types = {
    Voucher: [
      { name: "payer", type: "address" },
      { name: "payee", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint64" },
      { name: "ref", type: "bytes32" },
    ],
  };
  const independentHash = TypedDataEncoder.hash(domain, types, voucher);
  const independentSig = await w.signTypedData(domain, types, voucher);

  assert.deepEqual(x402Domain(CHAIN_ID, VAULT), domain);
  assert.equal(hashVoucher(CHAIN_ID, VAULT, voucher), independentHash);

  const sig = await signVoucher(w, CHAIN_ID, VAULT, voucher);
  assert.equal(sig, independentSig);
  assert.equal(verifyTypedData(domain, types, voucher, sig), w.address);
  assert.equal(verifyVoucherSig(CHAIN_ID, VAULT, voucher, sig), w.address);

  // Binds to chainId + verifyingContract + every field: any change flips the hash/recovered signer.
  assert.notEqual(hashVoucher(CHAIN_ID + 1, VAULT, voucher), independentHash);
  assert.notEqual(hashVoucher(CHAIN_ID, "0x000000000000000000000000000000000000C0FFEE".slice(0, 42), voucher), independentHash);
  assert.notEqual(verifyVoucherSig(CHAIN_ID, VAULT, { ...voucher, amount: voucher.amount + 1n }, sig), w.address);
  assert.notEqual(verifyVoucherSig(CHAIN_ID, VAULT, { ...voucher, nonce: voucher.nonce + 1n }, sig), w.address);
});

test("hashExecute matches an independently-built EIP-712 digest over (to,value,keccak(data),nonce,deadline)", async () => {
  const w = new Wallet(KEY);
  const to = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
  const value = 500_000_000_000_000_000n;
  const data = "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead";
  const nonce = 3n;
  const deadline = 1_900_000_100n;

  const domain = { name: "FerminuxAgentAccount", version: "1", chainId: CHAIN_ID, verifyingContract: ACCOUNT };
  const types = {
    Execute: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "dataHash", type: "bytes32" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint64" },
    ],
  };
  const msg = { to, value, dataHash: keccak256(data), nonce, deadline };
  const independentHash = TypedDataEncoder.hash(domain, types, msg);
  const independentSig = await w.signTypedData(domain, types, msg);

  assert.equal(AGENT_ACCOUNT_DOMAIN_NAME, "FerminuxAgentAccount");
  assert.equal(AGENT_ACCOUNT_DOMAIN_VERSION, "1");
  assert.deepEqual(agentAccountDomain(CHAIN_ID, ACCOUNT), domain);
  assert.equal(hashExecute(CHAIN_ID, ACCOUNT, to, value, data, nonce, deadline), independentHash);

  const sig = await signExecute(w, CHAIN_ID, ACCOUNT, to, value, data, nonce, deadline);
  assert.equal(sig, independentSig);
  assert.equal(verifyExecuteSig(CHAIN_ID, ACCOUNT, to, value, data, nonce, deadline, sig), w.address);

  // A relayed signature is bound to this exact account, chain, calldata and nonce.
  assert.notEqual(verifyExecuteSig(CHAIN_ID, "0x00000000000000000000000000000000DEADBEEF".slice(0, 42), to, value, data, nonce, deadline, sig), w.address);
  assert.notEqual(verifyExecuteSig(CHAIN_ID, ACCOUNT, to, value, "0x00", nonce, deadline, sig), w.address);
  assert.notEqual(verifyExecuteSig(CHAIN_ID, ACCOUNT, to, value, data, nonce + 1n, deadline, sig), w.address);

  // empty calldata (`data: "0x"`) hashes keccak256("0x"), not an empty/zero digest.
  const emptyDataHash = keccak256("0x");
  assert.equal(hashExecute(CHAIN_ID, ACCOUNT, to, value, "0x", nonce, deadline), TypedDataEncoder.hash(domain, types, { to, value, dataHash: emptyDataHash, nonce, deadline }));
});
