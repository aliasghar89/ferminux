// Where the pilot's ValidatorHub is, decided at build time (see pickHub in validatorPilot.ts):
//   1. VITE_VALIDATOR_HUB + VITE_VALIDATOR_HUB_LENS (+ VITE_VALIDATOR_DEPLOY_BLOCK): a test or local build;
//      VITE_VALIDATOR_HUB=off forces the "opens soon" page even when a record exists;
//   2. agents/deployments-validators.3961.json, the record `pilot.sh apply` writes on mainnet (committed after
//      the deploy). The glob matches nothing until that file exists, so no build step has to know about it;
//   3. neither: the page says the pilot opens soon and offers the waitlist only.
import { pickHub, type PilotHub } from "./validatorPilot";

const records = import.meta.glob("../../deployments-validators.3961.json", { eager: true, import: "default" }) as Record<string, unknown>;
const env = import.meta.env as unknown as Record<string, string | undefined>;

export const pilotHub: PilotHub | null = pickHub(
  { hub: env.VITE_VALIDATOR_HUB, lens: env.VITE_VALIDATOR_HUB_LENS, deployBlock: env.VITE_VALIDATOR_DEPLOY_BLOCK },
  Object.values(records)[0] ?? null,
);
