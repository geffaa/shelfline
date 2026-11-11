import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", timeout: 90_000, expect: { timeout: 10_000 }, fullyParallel: false, workers: 1, retries: 0, reporter: [["list"]],
  use: { baseURL: "http://localhost:8210", channel: "chrome", viewport: { width: 1180, height: 820 }, hasTouch: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: [
    { command: "pnpm --filter @shelfline/api e2e-server", url: "http://127.0.0.1:8201/auth/me", reuseExistingServer: false, timeout: 90_000, stdout: "pipe", ignoreHTTPSErrors: true, gracefulShutdown: { signal: "SIGTERM", timeout: 5000 } },
    { command: "pnpm build && pnpm preview", url: "http://localhost:8210", reuseExistingServer: false, timeout: 120_000 },
  ],
});
