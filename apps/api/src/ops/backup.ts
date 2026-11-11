import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";

const run = promisify(execFile);

/** A fingerprint of everything in the database that matters: every table's row count and a hash of every row, the sequences, and which tables have row-level security and which triggers exist. */
export interface Fingerprint { tables: Record<string, { rows: number; hash: string }>; sequences: Record<string, string>; rls: string[]; triggers: string[] }

export async function fingerprint(url: string): Promise<Fingerprint> {
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try {
    const names = (await c.query(`select table_name from information_schema.tables where table_schema = 'shelfline' and table_type = 'BASE TABLE' order by 1`)).rows.map((r) => r.table_name as string);
    const tables: Fingerprint["tables"] = {};
    for (const t of names) { const r = (await c.query(`select count(*)::int as n, coalesce(md5(string_agg(x::text, E'\\n' order by x::text)), '') as h from shelfline."${t}" x`)).rows[0]; tables[t] = { rows: r.n, hash: r.h }; }
    const sequences = Object.fromEntries((await c.query(`select sequencename, coalesce(last_value, 0)::text as v from pg_sequences where schemaname = 'shelfline' order by 1`)).rows.map((r) => [r.sequencename, r.v]));
    const rls = (await c.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'shelfline' and c.relkind = 'r' and c.relrowsecurity order by 1`)).rows.map((r) => r.relname as string);
    const triggers = (await c.query(`select c.relname || '.' || t.tgname as n from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'shelfline' and not t.tgisinternal order by 1`)).rows.map((r) => r.n as string);
    return { tables, sequences, rls, triggers };
  } finally { await c.end(); }
}

export interface RestoreReport { ok: boolean; dumpBytes: number; tables: number; rows: number; mismatches: string[]; seconds: number }

const swapDb = (url: string, db: string) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

/**
 * Dump a database, restore the dump into a fresh one next to it, and prove the copy is the same: identical fingerprint, with the
 * protections (row-level security, immutability triggers) still in place. The restored copy is dropped afterwards.
 * Roles are not part of a per-database dump; on a new server create them first (`pg_dumpall --roles-only`, or the migration's own `shelfline_app` role).
 */
export async function backupRestoreCheck(url: string, o: { keep?: boolean } = {}): Promise<RestoreReport> {
  const t0 = Date.now(); const dir = await mkdtemp(path.join(tmpdir(), "shelfline-backup-")); const file = path.join(dir, "backup.dump"); const copy = `${new URL(url).pathname.slice(1)}_restore_check`; const admin = swapDb(url, "postgres"); const target = swapDb(url, copy);
  const a = new pg.Client({ connectionString: admin }); await a.connect();
  try {
    const source = await fingerprint(url);
    await run("pg_dump", ["--format=custom", "--no-owner", `--file=${file}`, url], { maxBuffer: 1 << 26 });
    await a.query(`drop database if exists "${copy}" with (force)`); await a.query(`create database "${copy}"`);
    await run("pg_restore", ["--no-owner", "--exit-on-error", `--dbname=${target}`, file], { maxBuffer: 1 << 26 });
    const restored = await fingerprint(target); const mismatches: string[] = [];
    for (const t of new Set([...Object.keys(source.tables), ...Object.keys(restored.tables)])) { const s = source.tables[t], r = restored.tables[t]; if (!s || !r) mismatches.push(`table ${t} ${s ? "missing after restore" : "appeared"}`); else if (s.rows !== r.rows || s.hash !== r.hash) mismatches.push(`table ${t}: ${s.rows} rows ${s.hash.slice(0, 8)} -> ${r.rows} rows ${r.hash.slice(0, 8)}`); }
    for (const k of new Set([...Object.keys(source.sequences), ...Object.keys(restored.sequences)])) if (source.sequences[k] !== restored.sequences[k]) mismatches.push(`sequence ${k}: ${source.sequences[k]} -> ${restored.sequences[k]}`);
    if (source.rls.join() !== restored.rls.join()) mismatches.push("row-level security differs");
    if (source.triggers.join() !== restored.triggers.join()) mismatches.push("triggers differ");
    return { ok: mismatches.length === 0, dumpBytes: (await stat(file)).size, tables: Object.keys(source.tables).length, rows: Object.values(source.tables).reduce((n, t) => n + t.rows, 0), mismatches, seconds: (Date.now() - t0) / 1000 };
  } finally {
    if (!o.keep) await a.query(`drop database if exists "${copy}" with (force)`).catch(() => undefined);
    await a.end(); await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && /backup\.ts$/.test(process.argv[1])) {
  const url = process.env.DATABASE_URL ?? "postgres://shelfline:shelfline@localhost:54340/shelfline";
  backupRestoreCheck(url).then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }).catch((e) => { console.error(e); process.exit(2); });
}
