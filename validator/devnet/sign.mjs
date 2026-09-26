// Manual signatures for the devnet drills (what a second machine holding the same attester key
// would produce). The key comes from the sidecar's own scrypt keystore; devnet keys only.
//   node sign.mjs attest <keystore.json> <password-file> <chainId> <hub> <height> <blockHash>
//     -> {"address": ..., "sig": 0x<65 bytes, v 27/28, low s>, "digest": ...}
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, "..", "..", "explorer/web/package.json"));
const { ethers } = require("ethers");

const [cmd, ks, pwFile, chainId, hub, height, blockHash] = process.argv.slice(2);
if (cmd !== "attest") {
  console.error("usage: node sign.mjs attest <keystore.json> <password-file> <chainId> <hub> <height> <blockHash>");
  process.exit(2);
}
const w = await ethers.Wallet.fromEncryptedJson(readFileSync(ks, "utf8"), readFileSync(pwFile, "utf8"));
const domain = { name: "Ferminux Validator Hub", version: "1", chainId: BigInt(chainId), verifyingContract: hub };
const types = { Attestation: [{ name: "height", type: "uint64" }, { name: "blockHash", type: "bytes32" }] };
const value = { height: BigInt(height), blockHash };
const digest = ethers.TypedDataEncoder.hash(domain, types, value);
const sig = w.signingKey.sign(digest);
console.log(JSON.stringify({ address: w.address, sig: sig.serialized, digest }));
