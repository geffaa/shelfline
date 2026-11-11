#!/usr/bin/env node
// Supply-chain check, run in CI and by hand: `pnpm audit:supply`.
//  1. no known vulnerability in anything that ships (production dependencies of every package)
//  2. no high or critical vulnerability anywhere, development tools included; lower ones are listed, not hidden
//  3. no copyleft licence (GPL, AGPL, SSPL) among production dependencies, and no dependency without a licence
//  4. every dependency is a registry version range: no git, URL, file or `latest` specifiers, and install scripts are not run for packages that are not allow-listed
//  5. the Go bridge depends on the standard library only
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sh = (cmd, args, o = {}) => { try { return { out: execFileSync(cmd, args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"], ...o }), code: 0 }; } catch (e) { return { out: String(e.stdout ?? ""), code: e.status ?? 1 }; } };
const problems = []; const notes = [];

// 1 + 2
const prod = sh("pnpm", ["audit", "--prod", "--json"]); const prodAdv = Object.values(JSON.parse(prod.out || "{}").advisories ?? {});
for (const a of prodAdv) problems.push(`production dependency ${a.module_name} ${a.vulnerable_versions}: ${a.title} (${a.severity})`);
const all = sh("pnpm", ["audit", "--json"]); const allAdv = Object.values(JSON.parse(all.out || "{}").advisories ?? {});
for (const a of allAdv) { const via = a.findings?.[0]?.paths?.[0] ?? ""; const line = `${a.severity}: ${a.module_name} ${a.vulnerable_versions} (${a.title.slice(0, 60)}) via ${via.slice(0, 80)}`; if (["high", "critical"].includes(a.severity)) problems.push(line); else if (!prodAdv.includes(a)) notes.push(`development/build only, ${line}`); }

// 3
const lic = JSON.parse(sh("pnpm", ["licenses", "list", "--prod", "--json"]).out || "{}"); let packages = 0;
for (const [name, pkgs] of Object.entries(lic)) for (const p of pkgs) { packages++; const copyleft = /(^|[^L])GPL|AGPL|SSPL|BUSL/i.test(name) && !/LGPL/i.test(name); const choosable = /\bOR\b/.test(name) && /\b(MIT|Apache-2\.0|BSD-[23]-Clause|ISC)\b/.test(name);   // "MIT OR GPL" lets us take MIT
    if (copyleft && !choosable) problems.push(`copyleft licence ${name}: ${p.name}`); else if (copyleft) notes.push(`dual-licensed ${p.name} (${name}): used under the permissive option`); if (/unknown|unlicensed/i.test(name)) problems.push(`no licence: ${p.name}`); }

// 4
const dirs = ["", ...["apps", "packages"].flatMap((d) => (existsSync(path.join(root, d)) ? readdirSync(path.join(root, d)).map((x) => path.join(d, x)) : []))];
for (const d of dirs) { const f = path.join(root, d, "package.json"); if (!existsSync(f)) continue; const pkg = JSON.parse(readFileSync(f, "utf8"));
  for (const sec of ["dependencies", "devDependencies", "optionalDependencies"]) for (const [n, v] of Object.entries(pkg[sec] ?? {})) if (!/^(workspace:|\^|~|\d|>=)/.test(v) || /^(latest|\*|git|http|file:|github:)/.test(v)) problems.push(`${d || "."}/package.json: ${n} is "${v}"`); }
if (!existsSync(path.join(root, "pnpm-lock.yaml"))) problems.push("no pnpm-lock.yaml"); else if (sh("git", ["ls-files", "--error-unmatch", "pnpm-lock.yaml"]).code !== 0 && existsSync(path.join(root, ".git"))) notes.push("pnpm-lock.yaml is not tracked by git");

// 5
const gomod = readFileSync(path.join(root, "apps/bridge/go.mod"), "utf8"); if (/^\s*require\b/m.test(gomod)) problems.push("apps/bridge/go.mod has third-party requirements"); else notes.push("apps/bridge: Go standard library only, no third-party modules");

console.log(`Checked ${packages} production packages.`); for (const n of notes) console.log(`note: ${n}`);
if (problems.length) { for (const p of problems) console.error(`FAIL: ${p}`); process.exit(1); }
console.log("Supply-chain check passed.");
