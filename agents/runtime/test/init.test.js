// `ferminux-agent init` — the scaffolder writes a complete, valid project and
// refuses to clobber one.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject, projectFiles, slugify, titleCase } from "../dist/init.js";
import { RUNTIME_TARBALL, render } from "../dist/templates/project.js";

test("slugify / titleCase", () => {
  assert.equal(slugify("My Agent!"), "my-agent");
  assert.equal(slugify("---"), "ferminux-agent");
  assert.equal(titleCase("my-agent"), "My Agent");
  assert.equal(titleCase(""), "Ferminux Agent");
});

test("render leaves an unknown placeholder alone", () => {
  assert.equal(render("{{name}} / {{nope}}", { name: "Scribe" }), "Scribe / {{nope}}");
});

test("init scaffolds a complete project", (t) => {
  const dir = join(mkdtempSync(join(tmpdir(), "fmx-init-")), "demo");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = initProject({ dir, name: "Demo Agent", handler: "llm", price: "2", yes: true });
  assert.deepEqual(
    readdirSync(dir).sort(),
    [".dockerignore", ".env.example", ".gitignore", "Dockerfile", "README.md", "handler.js", "package.json"],
  );
  assert.equal(result.name, "Demo Agent");
  assert.match(result.summary, /npx ferminux-agent serve --id <id> --port 8801 --auto-claim/);
  assert.doesNotMatch(result.summary, /Defaults used/); // --yes silences the notice

  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.name, "demo-agent");
  assert.equal(pkg.dependencies["ferminux-agent"], RUNTIME_TARBALL);
  assert.match(pkg.scripts.start, /--handler llm --auto-claim/);
  assert.match(pkg.scripts.register, /--price 2 --bond 0/);
  assert.match(pkg.scripts["start:custom"], /--handler \.\/handler\.js/);

  const readme = readFileSync(join(dir, "README.md"), "utf8");
  for (const step of ["openssl rand -hex 32", "/api/faucet", "ferminux-agent register", "serve --id 42 --port 8801 --auto-claim"]) {
    assert.ok(readme.includes(step), `README is missing the "${step}" step`);
  }
  assert.doesNotMatch(readme, /\{\{\w+\}\}/); // every placeholder substituted

  const env = readFileSync(join(dir, ".env.example"), "utf8");
  for (const v of ["FERMINUX_PRIVATE_KEY", "AGENT_ID", "PORT", "DATA_DIR", "AGENT_AUTO_CLAIM", "AGENT_AUTO_CLAIM_MAX_PER_DAY", "PRICE_PER_CALL", "WEBHOOK_SECRET", "LLM_CLI"]) {
    assert.match(env, new RegExp(`^${v}=`, "m"), `.env.example is missing ${v}`);
  }

  assert.match(readFileSync(join(dir, "Dockerfile"), "utf8"), /^CMD \["npm", "start"\]$/m);
});

test("init names the agent after the directory and refuses a non-empty one", (t) => {
  const base = mkdtempSync(join(tmpdir(), "fmx-init2-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "night-scribe");
  mkdirSync(dir);
  writeFileSync(join(dir, "keep.txt"), "x");

  assert.throws(() => initProject({ dir, handler: "echo" }), /is not empty/);

  const result = initProject({ dir, handler: "echo", force: true });
  assert.equal(result.name, "Night Scribe");
  assert.match(result.summary, /Defaults used: name "Night Scribe", handler echo, price 1 FMX/);
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name, "night-scribe");
  assert.ok(readdirSync(dir).includes("keep.txt")); // --force adds, it does not wipe
});

test("every generated file is non-empty and placeholder-free", () => {
  const vars = {
    name: "Scribe",
    slug: "scribe",
    handler: "llm",
    price: "1",
    runtimeTarball: RUNTIME_TARBALL,
    sdkTarball: "https://ferminux.net/downloads/ferminux-sdk.tgz",
    site: "https://ferminux.net",
    gateway: "https://ferminux.net/api",
    rpc: "https://rpc.ferminux.net",
    explorer: "https://explorer.ferminux.net",
    chainId: "3961",
  };
  for (const [name, body] of Object.entries(projectFiles(vars))) {
    assert.ok(body.length > 20, `${name} is empty`);
    assert.doesNotMatch(body, /\{\{\w+\}\}/, `${name} has an unsubstituted placeholder`);
  }
  JSON.parse(projectFiles(vars)["package.json"]); // valid JSON
});
