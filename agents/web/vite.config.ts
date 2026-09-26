import { defineConfig, type Plugin } from "vite";
import { resolve, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

// Shared chrome: <!-- @head -->, <!-- @header -->, <!-- @footer --> are replaced at build
// time from src/partials so every page ships the same static header/footer (no JS flash).
function citizens(): { name: string; symbol: string } {
  try {
    const c = JSON.parse(readFileSync(resolve(root, "../nft/citizens/tiers.json"), "utf8")).collection;
    return { name: String(c.name), symbol: String(c.symbol) };
  } catch {
    return { name: "Ferminux Citizens", symbol: "FMXC" };
  }
}

function partials(): Plugin {
  const read = (n: string) => readFileSync(resolve(root, "src/partials", n), "utf8");
  // Home keeps the landing footer (big links + wordmark). App pages get the compact one: the <!-- @home -->
  // blocks are cut, leaving the four small columns and the copyright row.
  const footer = (home: boolean) => {
    const f = read("footer.html");
    return home ? f : f.replace(/<!-- @home -->[\s\S]*?<!-- \/@home -->\s*/g, "").replace('class="site-footer bigfoot"', 'class="site-footer bigfoot appfoot"');
  };
  return {
    name: "ferminux-partials",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const path = ctx.path.replace(/index\.html$/, "");
        // the first path segment names the nav item: /nfts/citizens/ is still "nfts"
        const nav = path === "/" ? "home" : path.split("/").filter(Boolean)[0] ?? "home";
        let header = read("header.html");
        header = header.replace(new RegExp(`data-nav="${nav}"`), `data-nav="${nav}" aria-current="page"`);
        // og:url follows the page's canonical (or its own path), so a shared link names the page it came from.
        // A page that writes its own og:url keeps it.
        let head = read("head.html");
        // A page with its own share image (the /nfts/ mosaic) drops the site card, so crawlers see one og:image.
        if (/property="og:image"/.test(html)) head = head.replace(/<meta property="og:image[^>]*>\n?/g, "");
        if (!/property="og:url"/.test(html)) {
          const canon = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] ?? `https://ferminux.net${path}`;
          head += `\n<meta property="og:url" content="${canon}">`;
        }
        // Ferminux Citizens: name and symbol come from agents/nft/citizens/tiers.json, the one place to rename them
        const cc = citizens();
        return html
          .replaceAll("%CITIZENS_NAME%", cc.name)
          .replaceAll("%CITIZENS_SYMBOL%", cc.symbol)
          .replace("<!-- @head -->", head)
          .replace("<!-- @header -->", header)
          .replace("<!-- @footer -->", footer(nav === "home"));
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
        nftsCitizens: resolve(root, "nfts/citizens/index.html"),
        // Addendum v3 — Agent Economy
        agentWallets: resolve(root, "agent-wallets/index.html"),
        x402: resolve(root, "x402/index.html"),
        streams: resolve(root, "streams/index.html"),
        disputes: resolve(root, "disputes/index.html"),
        tokens: resolve(root, "tokens/index.html"),
        compute: resolve(root, "compute/index.html"),
        memory: resolve(root, "memory/index.html"),
        buyFmx: resolve(root, "buy-fmx/index.html"),
        // Where FMX trades (the Ferminux DEX first, PancakeSwap second), gas for a new key, and the deploy quickstart
        trade: resolve(root, "trade/index.html"),
        faucet: resolve(root, "faucet/index.html"),
        developers: resolve(root, "developers/index.html"),
        // Growth — agent invite kit
        invite: resolve(root, "invite/index.html"),
        // The record — public agent CV + the hiring network
        cv: resolve(root, "cv/index.html"),
        network: resolve(root, "network/index.html"),
        // Operations + try-it-here
        status: resolve(root, "status/index.html"),
        playground: resolve(root, "playground/index.html"),
        // The chain's public record: how blocks are confirmed, what protects the bridge, the 160,000 switch.
        // Built here so they share the site's chrome and tokens; they publish at /consensus.html etc.
        consensus: resolve(root, "consensus.html"),
        security: resolve(root, "security.html"),
        fork: resolve(root, "fork.html"),
        // The validator programme (in development): what a seat is, the planned terms and the waitlist.
        validators: resolve(root, "validators/index.html"),
        // nginx error_page target for unknown paths (see README "Deploy").
        notFound: resolve(root, "404.html"),
      },
    },
  },
  server: { port: 4178 },
  preview: { port: 4179 },
});
