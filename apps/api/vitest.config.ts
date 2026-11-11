import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"], fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000,
    env: {
      DATABASE_URL: "postgres://shelfline:shelfline@localhost:54340/shelfline_test",
      JWT_SECRET: "test-secret-test-secret-test-secret-123", ENCRYPTION_KEY: "11".repeat(32), DEV_MAILBOX: "1", SHOP_IP_LIMIT: "100000", SHOPIFY_API_BASE: "http://127.0.0.1:19480", XERO_API_BASE: "http://127.0.0.1:19490", XERO_TOKEN_URL: "http://127.0.0.1:19490/connect/token", SIMULATED_CARD_DELAY_MS: "250",
      PIN_MAX_ATTEMPTS: "5", PIN_LOCK_MINUTES: "15",
    },
  },
});
