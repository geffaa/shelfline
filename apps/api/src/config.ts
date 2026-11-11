export interface Config {
  databaseUrl: string; appDatabaseUrl: string; jwtSecret: string; encryptionKey: Buffer; port: number;
  adminTokenTtlSec: number; posTokenTtlSec: number; pinMaxAttempts: number; pinLockMinutes: number;
  /** When on, `GET /dev/mailbox` shows the mail the system would have sent. For development, tests and the demo only. */
  devMailbox: boolean; portalUrl: string;
  /** Which card terminal backend takes the payment. `simulated` needs nothing; `stripe` talks to Stripe Terminal in server-driven mode with the key below (test keys first: see docs/HARDWARE-TESTS.md, V11). */
  cardProvider: "simulated" | "stripe"; stripeSecretKey: string; stripeApiBase: string; simulatedCardDelayMs: number;
  /** Online orders one network address may place in ten minutes. */
  shopIpLimit: number;
  /** Tests and local trials only: send every Shopify API call here instead of to the shop's own address. */
  shopifyApiBase: string;
  /** The address customers can reach the API at, used for the unsubscribe link in marketing email. */
  publicApiUrl: string; adminUrl: string;
  /** Where the Xero API and its token service are. The defaults are Xero's own; tests and trials point them elsewhere. */
  xeroApiBase: string; xeroTokenUrl: string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const jwtSecret = env.JWT_SECRET ?? "";
  if (jwtSecret.length < 32) throw new Error("JWT_SECRET must be at least 32 characters");
  if (env.CARD_PROVIDER === "stripe" && !env.STRIPE_SECRET_KEY) throw new Error("CARD_PROVIDER=stripe needs STRIPE_SECRET_KEY");
  const key = Buffer.from(env.ENCRYPTION_KEY ?? "", "hex");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  return {
    databaseUrl: env.DATABASE_URL ?? "postgres://shelfline:shelfline@localhost:54340/shelfline",
    // The role the running application uses: not a superuser, so row-level security applies. DATABASE_URL (the owner) is for migrations, tests and scripts.
    appDatabaseUrl: env.APP_DATABASE_URL ?? env.DATABASE_URL?.replace(/\/\/[^@]*@/, "//shelfline_app:shelfline_app@") ?? "postgres://shelfline_app:shelfline_app@localhost:54340/shelfline",
    jwtSecret, encryptionKey: key, port: Number(env.PORT ?? 8200),
    adminTokenTtlSec: 15 * 60, posTokenTtlSec: 10 * 60 * 60,
    pinMaxAttempts: Number(env.PIN_MAX_ATTEMPTS ?? 5), pinLockMinutes: Number(env.PIN_LOCK_MINUTES ?? 15),
    devMailbox: env.DEV_MAILBOX === "1", portalUrl: env.PORTAL_URL ?? "http://localhost:8230",
    cardProvider: env.CARD_PROVIDER === "stripe" ? "stripe" : "simulated", stripeSecretKey: env.STRIPE_SECRET_KEY ?? "", stripeApiBase: (env.STRIPE_API_BASE ?? "https://api.stripe.com").replace(/\/$/, ""), simulatedCardDelayMs: Number(env.SIMULATED_CARD_DELAY_MS ?? 2000), shopIpLimit: Number(env.SHOP_IP_LIMIT ?? 20), shopifyApiBase: (env.SHOPIFY_API_BASE ?? "").replace(/\/$/, ""), adminUrl: (env.ADMIN_URL ?? "http://localhost:8220").replace(/\/$/, ""), publicApiUrl: (env.PUBLIC_API_URL ?? "http://localhost:8200").replace(/\/$/, ""), xeroApiBase: (env.XERO_API_BASE ?? "https://api.xero.com").replace(/\/$/, ""), xeroTokenUrl: env.XERO_TOKEN_URL ?? "https://identity.xero.com/connect/token",
  };
}
export const CONFIG = Symbol("CONFIG");
