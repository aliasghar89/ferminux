// Idempotent registration for the Ferminux Agent action.
//
// Looks for an agent the signing key already owns with this exact name
// (GET /api/agents?q=<name>, then match on `owner`). Found → update its
// endpoint / price / metadata. Not found → register it. So a workflow that
// runs on every push registers once and keeps the registration in step with
// the repository afterwards.
import { Ferminux } from "@ferminux/agent";
import { appendFileSync } from "node:fs";

const name = (process.env.INPUT_NAME ?? "").trim();
const endpoint = (process.env.INPUT_ENDPOINT ?? "").trim();
const price = (process.env.INPUT_PRICE ?? "1").trim();
const bond = (process.env.INPUT_BOND ?? "0").trim();
const metadataURI = (process.env.INPUT_METADATA_URI ?? "").trim();

if (!name) fail("input `name` is required");
if (!endpoint) fail("input `endpoint` is required");
if (!/^https?:\/\//i.test(endpoint)) fail(`input \`endpoint\` must be an absolute URL, got "${endpoint}"`);
if (!process.env.FERMINUX_PRIVATE_KEY) fail("input `private-key` is required (pass a repository secret)");

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function output(key, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines}\n`);
}

const fmx = new Ferminux({
  privateKey: process.env.FERMINUX_PRIVATE_KEY,
  rpc: process.env.FERMINUX_RPC || undefined,
  gateway: process.env.FERMINUX_GATEWAY || undefined,
});
const owner = fmx.requireSigner().address.toLowerCase();

// The indexer's `q` is a search, not an exact match — filter it down ourselves.
const { items } = await fmx.agents.list({ q: name, limit: 100 });
const mine = items.filter(
  (a) => a.owner?.toLowerCase() === owner && a.name?.trim().toLowerCase() === name.toLowerCase() && a.status !== "Retired",
);
// More than one (registered twice before this action existed): keep the oldest id.
const existing = mine.sort((a, b) => a.id - b.id)[0];

if (!existing) {
  const { id, tx } = await fmx.agents.register({ name, endpoint, metadataURI, pricePerJob: Number(price), bond: Number(bond) });
  console.log(`registered "${name}" as agent #${id} (${tx})`);
  output("agent-id", id);
  output("action", "registered");
  output("tx", tx);
  summary(`### Ferminux\nRegistered **${name}** as agent \`#${id}\`\n\n- endpoint: ${endpoint}\n- price: ${price} FMX\n- tx: \`${tx}\``);
  process.exit(0);
}

const samePrice = BigInt(existing.pricePerJob) === (await priceWei(price));
const unchanged = samePrice && existing.endpoint === endpoint && (existing.metadataURI ?? "") === metadataURI;

if (unchanged) {
  console.log(`agent #${existing.id} "${name}" is already up to date — nothing to do`);
  output("agent-id", existing.id);
  output("action", "unchanged");
  output("tx", "");
  summary(`### Ferminux\nAgent \`#${existing.id}\` (**${name}**) already matches this repository — no transaction sent.`);
  process.exit(0);
}

const { tx } = await fmx.agents.update({ id: existing.id, endpoint, metadataURI, pricePerJob: Number(price) });
console.log(`updated agent #${existing.id} "${name}" (${tx})`);
output("agent-id", existing.id);
output("action", "updated");
output("tx", tx);
summary(`### Ferminux\nUpdated agent \`#${existing.id}\` (**${name}**)\n\n- endpoint: ${endpoint}\n- price: ${price} FMX\n- tx: \`${tx}\``);

/** FMX (decimal string) -> wei, without pulling ethers in directly. */
async function priceWei(fmxAmount) {
  const { parseEther } = await import("ethers");
  return parseEther(fmxAmount);
}
