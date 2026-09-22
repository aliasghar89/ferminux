// Sign a 32-byte digest with a validator keystore (key never leaves the store).
// Usage: node sign-digest.mjs <role> <digest>   -> prints (v,r,s) tuple for cast
import { Wallet, Signature } from "ethers";
import { readFileSync } from "node:fs";
const [role, digest] = process.argv.slice(2);
const KEYS = process.env.FMX_REHEARSAL_KEYS
  ?? new URL("../keys/", import.meta.url).pathname;
const w = await Wallet.fromEncryptedJson(
  readFileSync(`${KEYS}/${role}.keystore.json`, "utf8"),
  readFileSync(`${KEYS}/${role}.password`, "utf8").trim()
);
// EIP-712 digest is already the final hash: sign the raw digest, no message prefix.
const sig = w.signingKey.sign(digest);
const s = Signature.from(sig);
process.stdout.write(`(${s.v},${s.r},${s.s})`);
