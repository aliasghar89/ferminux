/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Index (REST v2) base. Default "/api/v2": same origin in production, the dev proxy in `npm run dev`. */
  readonly VITE_API_BASE?: string;
  /** Chain RPC. Default https://rpc.ferminux.net (CORS *, 50 req/s per IP, a batch counts as one). */
  readonly VITE_RPC?: string;
  /** Agent gateway. Default https://ferminux.net/api (CORS *, checked 2026-09-24). */
  readonly VITE_GATEWAY?: string;
  /** "1" = answer /api/v2/* from fixtures/ in `npm run dev` (see vite.config.ts). */
  readonly VITE_FIXTURES?: string;
  /** ValidatorHub / ValidatorHubLens address overrides for local dev / the Playwright smoke
   *  (validators/config.ts). Default: contracts.3961.json's validatorHub / validatorHubLens, both null
   *  until the contracts lane deploys them (Step 1, no consensus change). */
  readonly VITE_VALIDATOR_HUB?: string;
  readonly VITE_VALIDATOR_HUB_LENS?: string;
}
interface Window { ethereum?: { request(a: { method: string; params?: unknown[] }): Promise<unknown> } }
