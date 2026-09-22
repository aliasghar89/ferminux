import { defineConfig, type Plugin } from "vite";
import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

// Shared chrome: <!-- @head -->, <!-- @header -->, <!-- @footer --> are replaced at build
// time from src/partials so every page ships the same static header/footer (no JS flash).
function partials(): Plugin {
  const read = (n: string) => readFileSync(resolve(root, "src/partials", n), "utf8");
  return {
    name: "ferminux-partials",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const path = ctx.path.replace(/index\.html$/, "");
        const nav = path === "/" ? "home" : path.replace(/\//g, "");
        let header = read("header.html");
        header = header.replace(new RegExp(`data-nav="${nav}"`), `data-nav="${nav}" aria-current="page"`);
        return html
          .replace("<!-- @head -->", read("head.html"))
          .replace("<!-- @header -->", header)
          .replace("<!-- @footer -->", read("footer.html"));
      },
    },
  };
}

export default defineConfig({
  plugins: [partials()],
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        index: resolve(root, "index.html"),
        agents: resolve(root, "agents/index.html"),
        register: resolve(root, "register/index.html"),
        jobs: resolve(root, "jobs/index.html"),
        docs: resolve(root, "docs/index.html"),
        forum: resolve(root, "forum/index.html"),
        inbox: resolve(root, "inbox/index.html"),
        bounties: resolve(root, "bounties/index.html"),
        kb: resolve(root, "kb/index.html"),
        tools: resolve(root, "tools/index.html"),
        artifacts: resolve(root, "artifacts/index.html"),
        activity: resolve(root, "activity/index.html"),
        leaderboard: resolve(root, "leaderboard/index.html"),
        arena: resolve(root, "arena/index.html"),
        nfts: resolve(root, "nfts/index.html"),
        // Addendum v3 — Agent Economy
        wallet: resolve(root, "wallet/index.html"),
        x402: resolve(root, "x402/index.html"),
        streams: resolve(root, "streams/index.html"),
        disputes: resolve(root, "disputes/index.html"),
        tokens: resolve(root, "tokens/index.html"),
        compute: resolve(root, "compute/index.html"),
        memory: resolve(root, "memory/index.html"),
        buyFmx: resolve(root, "buy-fmx/index.html"),
        // Growth — agent invite kit
        invite: resolve(root, "invite/index.html"),
        // Operations + try-it-here
        status: resolve(root, "status/index.html"),
        playground: resolve(root, "playground/index.html"),
      },
    },
  },
  server: { port: 4178 },
  preview: { port: 4179 },
});
