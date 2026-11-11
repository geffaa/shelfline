#!/usr/bin/env node
/**
 * Loads a queue exported from a till's Sync screen ("Export unsent") into the server, as that till.
 * Use it when an iPad's storage is in doubt: the commands keep their ids and sequence numbers, so anything the server already has is recognised and skipped.
 *
 *   node tools/import-queue.mjs <file.json> --api http://host:8200 --device-key <key> --employee <code> --pin <pin>
 */
import { readFileSync } from "node:fs";
const a = process.argv.slice(2); const file = a.find((x) => !x.startsWith("--") && x.endsWith(".json"));
const opt = (n) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : undefined; };
const api = (opt("api") ?? "").replace(/\/+$/, ""), key = opt("device-key"), code = opt("employee"), pin = opt("pin");
if (!file || !api || !key || !code || !pin) { console.error("usage: import-queue.mjs <file.json> --api URL --device-key KEY --employee CODE --pin PIN"); process.exit(1); }
const q = JSON.parse(readFileSync(file, "utf8")); if (q.format !== "shelfline-queue" || !Array.isArray(q.commands)) { console.error("not a Shelfline queue export"); process.exit(1); }
const post = async (path, body, headers) => { const r = await fetch(api + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); const t = await r.text(); if (!r.ok) throw new Error(`${path} → ${r.status} ${t.slice(0, 200)}`); return JSON.parse(t); };
const { token } = await post("/pos/pin", { employeeCode: code, pin }, { "x-device-key": key });
const tally = {};
for (let i = 0; i < q.commands.length; i += 100) {
  const res = await post("/sync/push", { deviceNow: new Date().toISOString(), commands: q.commands.slice(i, i + 100) }, { authorization: `Bearer ${token}` });
  for (const r of res.results) { const k = r.status + (r.reason ? ` (${r.reason})` : ""); tally[k] = (tally[k] ?? 0) + 1; }
  if (res.halted) { console.error("server stopped at a gap:", JSON.stringify(res.halted)); break; }
}
console.log(`${q.commands.length} commands from ${q.exportedAt}:`, tally);
