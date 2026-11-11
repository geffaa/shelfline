import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { CONFIG, type Config } from "../config";
import * as schema from "./schema";
import { currentTenant } from "./tenant";

/**
 * A pool that tells Postgres, every time it lends out a connection, which organisation the caller acts for.
 * The setting is session-level and rewritten on every checkout, so it can never carry over from the previous borrower.
 */
export class TenantPool extends pg.Pool {
  private stamp = async (c: pg.PoolClient) => { const t = currentTenant(); await c.query("select set_config('app.org_id', $1, false), set_config('app.system', $2, false)", [t?.orgId ?? "", t?.orgId ? "off" : "on"]); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override connect(cb?: any): any {
    if (cb) { super.connect((e: Error | undefined, c: pg.PoolClient | undefined, done: (r?: unknown) => void) => { if (e || !c) return cb(e, c, done); this.stamp(c).then(() => cb(undefined, c, done), (x) => { done(x); cb(x); }); }); return undefined; }
    return super.connect().then(async (c) => { try { await this.stamp(c); } catch (e) { c.release(e as Error); throw e; } return c; });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override query(...args: any[]): any {
    const run = async () => { const c = await this.connect(); try { return await (c.query as (...a: unknown[]) => Promise<unknown>)(...args); } finally { c.release(); } };
    return typeof args[args.length - 1] === "function" ? (run().then((r) => args[args.length - 1](null, r), (e) => args[args.length - 1](e)), undefined) : run();
  }
}

export const DB = Symbol("DB");
export type Db = NodePgDatabase<typeof schema>;
export const POOL = Symbol("POOL");

@Injectable()
class PoolCloser implements OnApplicationShutdown {
  constructor(@Inject(POOL) private pool: pg.Pool) {}
  async onApplicationShutdown() { await this.pool.end(); }
}

@Global()
@Module({
  providers: [
    { provide: POOL, inject: [CONFIG], useFactory: (c: Config) => new TenantPool({ connectionString: c.appDatabaseUrl, max: 10 }) },
    { provide: DB, inject: [POOL], useFactory: (p: pg.Pool) => drizzle(p, { schema }) },
    PoolCloser,
  ],
  exports: [DB, POOL],
})
export class DbModule {}
