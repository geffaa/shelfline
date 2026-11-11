import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", timeout: 90_000, expect: { timeout: 10_000 }, fullyParallel: false, workers: 1, retries: 0, reporter: [["list"]],
  use: { baseURL: "http://localhost:8250", timezoneId: "Pacific/Auckland", channel: "chrome", viewport: { width: 1280, height: 860 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: [
    { command: "pnpm --filter @shelfline/api e2e-server", url: "http://127.0.0.1:8201/auth/me", reuseExistingServer: false, timeout: 90_000, stdout: "pipe", gracefulShutdown: { signal: "SIGTERM", timeout: 5000 } },
    { command: "SHELFLINE_API_URL=http://localhost:8201 pnpm build && SHELFLINE_API_URL=http://localhost:8201 pnpm start", url: "http://localhost:8250", reuseExistingServer: false, timeout: 240_000 },
  ],
});
