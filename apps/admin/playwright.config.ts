import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", timeout: 90_000, expect: { timeout: 10_000 }, fullyParallel: false, workers: 1, retries: 0, reporter: [["list"]],
  use: { baseURL: "http://localhost:8220", timezoneId: "Pacific/Auckland", channel: "chrome", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure", screenshot: "only-on-failure", acceptDownloads: true },
  webServer: [
    { command: "pnpm --filter @shelfline/api e2e-server", url: "http://127.0.0.1:8201/auth/me", reuseExistingServer: false, timeout: 90_000, stdout: "pipe", gracefulShutdown: { signal: "SIGTERM", timeout: 5000 } },
    { command: "VITE_API_URL=http://localhost:8201 pnpm build && VITE_API_URL=http://localhost:8201 pnpm preview", url: "http://localhost:8220", reuseExistingServer: false, timeout: 120_000 },
  ],
});
