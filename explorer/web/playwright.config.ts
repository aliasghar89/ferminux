// Playwright smoke config (tests/*.spec.ts). Currently just the validators lane
// (scratchpad/validators/PLAN.md): phone (390) and desktop (1440), against the real production build with
// VITE_VALIDATOR_HUB + VITE_VALIDATOR_HUB_LENS set so the (normally dark) validators pages render against a
// mocked hub and lens — see tests/validators.smoke.spec.ts for why those env vars never touch the
// checked-in address book.
import { defineConfig, devices } from "@playwright/test";

const PORT = 4191;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // --host 127.0.0.1: vite preview's default bind isn't reachable at 127.0.0.1 in every sandbox; be explicit.
    command: `VITE_VALIDATOR_HUB=0x1234567890123456789012345678901234567890 VITE_VALIDATOR_HUB_LENS=0x5678901234567890123456789012345678901234 npm run build && npm run preview -- --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
