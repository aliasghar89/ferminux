// `ferminux-agent init [dir]` — scaffolds a ready-to-run agent project:
// package.json, handler.js, .env.example, README.md, .gitignore, Dockerfile.
// The generated project depends on the published runtime tarball, so it runs
// with no checkout of this repo. Templates are string constants (templates/
// project.ts) because the published package ships `dist/` only.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  CHAIN_ID,
  DOCKERFILE,
  DOCKERIGNORE,
  ENV_EXAMPLE,
  EXPLORER,
  GATEWAY,
  GITIGNORE,
  HANDLER_JS,
  PKG_JSON,
  README_MD,
  RPC,
  RUNTIME_TARBALL,
  SDK_TARBALL,
  SITE,
  render,
  type TemplateVars,
} from "./templates/project.js";

export type InitHandler = "llm" | "echo" | "tools" | "chain";

export interface InitOptions {
  /** target directory (default ".") */
  dir: string;
  /** agent name (default: the directory's basename, title-cased) */
  name?: string;
  handler: InitHandler;
  /** price per job in FMX (default "1") */
  price?: string;
  /** write into a non-empty directory */
  force?: boolean;
  /** accept the defaults without the "review these" notice */
  yes?: boolean;
}

export interface InitResult {
  dir: string;
  name: string;
  files: string[];
  /** next steps, printed to stdout */
  summary: string;
}

/** "My Agent" → "my-agent" (npm-safe, also used for the docker image/volume name). */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "ferminux-agent";
}

/** "my-agent" → "My Agent" (only used when --name is omitted). */
export function titleCase(slug: string): string {
  const words = slug
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(" ") || "Ferminux Agent";
}

/** The files `init` writes, as published path → contents. Pure, so tests can assert on it. */
export function projectFiles(vars: TemplateVars): Record<string, string> {
  return {
    "package.json": render(PKG_JSON, vars),
    "handler.js": render(HANDLER_JS, vars),
    ".env.example": render(ENV_EXAMPLE, vars),
    ".gitignore": render(GITIGNORE, vars),
    ".dockerignore": render(DOCKERIGNORE, vars),
    Dockerfile: render(DOCKERFILE, vars),
    "README.md": render(README_MD, vars),
  };
}

export function initProject(opts: InitOptions): InitResult {
  const dir = isAbsolute(opts.dir) ? opts.dir : resolve(process.cwd(), opts.dir);
  if (existsSync(dir)) {
    const entries = readdirSync(dir);
    if (entries.length && !opts.force) {
      throw new Error(`${dir} is not empty (${entries.length} entries) — pass --force to scaffold into it anyway`);
    }
  } else {
    mkdirSync(dir, { recursive: true });
  }

  const name = (opts.name || titleCase(basename(dir))).trim();
  const price = (opts.price || "1").trim();
  const vars: TemplateVars = {
    name,
    slug: slugify(name),
    handler: opts.handler,
    price,
    runtimeTarball: RUNTIME_TARBALL,
    sdkTarball: SDK_TARBALL,
    site: SITE,
    gateway: GATEWAY,
    rpc: RPC,
    explorer: EXPLORER,
    chainId: String(CHAIN_ID),
  };

  const files = projectFiles(vars);
  const written: string[] = [];
  for (const [rel, contents] of Object.entries(files)) {
    const path = join(dir, rel);
    if (existsSync(path) && !opts.force) throw new Error(`${path} already exists — pass --force to overwrite`);
    writeFileSync(path, contents);
    written.push(rel);
  }

  const where = opts.dir === "." ? "." : opts.dir;
  const notice = opts.yes
    ? ""
    : `\nDefaults used: name "${name}", handler ${opts.handler}, price ${price} FMX. Pass --name / --handler / --price to change them (--yes silences this line).\n`;
  const summary =
    `Scaffolded ${name} in ${dir}\n` +
    written.map((f) => `  ${f}`).join("\n") +
    notice +
    `\nNext:\n` +
    `  1.  cd ${where} && npm install\n` +
    `  2.  export FERMINUX_PRIVATE_KEY=0x$(openssl rand -hex 32)\n` +
    `      npx -y -p ${SDK_TARBALL} ferminux wallet          # prints your address\n` +
    `  3.  curl -s -X POST ${GATEWAY}/faucet -H 'content-type: application/json' \\\n` +
    `        -d '{"address":"0xYOUR_ADDRESS"}'               # 0.5 FMX of gas\n` +
    `  4.  cp .env.example .env                              # fill in the key\n` +
    `      npx ferminux-agent register --name "${name}" --endpoint https://your-host.example --price ${price} --bond 0\n` +
    `  5.  npx ferminux-agent serve --id <id> --port 8801 --auto-claim\n` +
    `\nEdit handler.js for the work you sell, then serve it with --handler ./handler.js.\n` +
    `README.md in ${where} has the same path with every detail. Your card appears at ${SITE}/agents/.`;

  return { dir, name, files: written, summary };
}
