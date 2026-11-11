import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import pg from "pg";
import { Subject } from "rxjs";
import { CONFIG, type Config } from "../config";

export interface DomainEvent { org: string; loc: string | null; kind: string; id: string }

/** One dedicated connection LISTENs to Postgres; every API client's stream is a filtered view of it. Reconnects with backoff if the connection drops. */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  readonly events = new Subject<DomainEvent>();
  private client: pg.Client | null = null; private closed = false; private timer: NodeJS.Timeout | null = null; private log = new Logger("events");
  constructor(@Inject(CONFIG) private cfg: Config) {}
  async onModuleInit() { await this.connect(); }
  async onModuleDestroy() { this.closed = true; if (this.timer) clearTimeout(this.timer); this.events.complete(); await this.client?.end().catch(() => undefined); }

  private async connect(attempt = 0): Promise<void> {
    if (this.closed) return;
    const c = new pg.Client({ connectionString: this.cfg.databaseUrl });
    c.on("notification", (m) => { try { this.events.next(JSON.parse(m.payload ?? "{}") as DomainEvent); } catch { /* ignore malformed payloads */ } });
    c.on("error", () => { void this.retry(c, attempt + 1); }); c.on("end", () => { void this.retry(c, attempt + 1); });
    try { await c.connect(); await c.query("LISTEN shelfline_events"); this.client = c; }
    catch (e) { this.log.warn(`LISTEN failed: ${String(e)}`); void this.retry(c, attempt + 1); }
  }
  private retrying = false;
  private async retry(old: pg.Client, attempt: number) {
    if (this.closed || this.retrying) return; this.retrying = true; await old.end().catch(() => undefined);
    this.timer = setTimeout(() => { this.retrying = false; void this.connect(attempt); }, Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)));
  }
}
