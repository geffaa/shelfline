import type { INestApplication } from "@nestjs/common";
import { tenantMiddleware } from "./db/tenant";
/** Shared between main.ts and the test harness. */
export function configureApp(app: INestApplication, env: NodeJS.ProcessEnv = process.env) {
  app.use(tenantMiddleware);
  // Browsers (the POS PWA, the admin, the report portal) call the API cross-origin. Only listed origins get CORS headers; the device key and bearer token travel in headers, never cookies.
  const origins = (env.CORS_ORIGINS ?? "http://localhost:8210,http://127.0.0.1:8210,http://localhost:8220,http://127.0.0.1:8220,http://localhost:8230,http://127.0.0.1:8230,http://localhost:8250,http://127.0.0.1:8250").split(",").map((x) => x.trim()).filter(Boolean);
  app.enableCors({ origin: origins, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], allowedHeaders: ["authorization", "content-type", "x-device-key", "x-bridge-id", "x-timestamp", "x-signature"], maxAge: 600 });
  // The bridge signs its exact request bytes, so the raw body is kept next to the parsed one.
  (app as unknown as { useBodyParser: (t: string, o: object) => void }).useBodyParser("json", { limit: "2mb", verify: (req: { rawBody?: Buffer }, _res: unknown, buf: Buffer) => { req.rawBody = buf; } });
  (app as unknown as { useBodyParser: (t: string, o: object) => void }).useBodyParser("text", { type: ["text/csv", "text/plain"], limit: "8mb" });
}
