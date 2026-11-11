/**
 * Scripted demo recording of Shelfline (same method as the Tallyard, Telusur and Shopify demos).
 *   pnpm demo (seed) and pnpm dev (API :8200, POS :8210, admin :8220) running, then:
 *   cd demo && npm install && node record.mjs          (REUSE=1 keeps scenes already recorded)
 * Output: demo/out/shelfline-demo.mp4 (needs ffmpeg and Chrome). Each scene is a Puppeteer screencast; slides are stills.
 */
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

const ADMIN = process.env.ADMIN || 'http://localhost:8220';
const POS = process.env.POS || 'http://localhost:8210';
const devices = JSON.parse(readFileSync(new URL('../apps/api/.demo-devices.json', import.meta.url), 'utf8'));
const till = devices.find((d) => d.register === 'FIT-2');
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const W = 1440, H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = { ink: '#14171C', ink2: '#434B58', ink3: '#5B6472', volt: '#C9E73A', voltText: '#415208', ground: '#ECEFF2', line: '#D8DDE4', ok: '#1A7443' };

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', defaultViewport: null, args: [`--window-size=${W},${H}`, '--hide-scrollbars'] });

const OVERLAY = `
  (() => {
    if (window.__demo) return; window.__demo = true;
    const css = document.createElement('style');
    css.textContent = \`
      #demo-cursor { position: fixed; z-index: 2147483647; width: 22px; height: 22px; margin: -3px 0 0 -3px; pointer-events: none; transition: transform 60ms linear; }
      #demo-cursor.down { transform: scale(.82); }
      #demo-cap { position: fixed; z-index: 2147483646; left: 50%; bottom: 36px; transform: translate(-50%, 12px); opacity: 0;
        background: ${C.ink}; color: #fff; font: 600 15px/1.4 Archivo, system-ui, sans-serif; border-radius: 999px;
        padding: 12px 22px 11px; max-width: 860px; text-align: center; pointer-events: none;
        transition: opacity 240ms ease, transform 240ms ease; box-shadow: 0 10px 30px rgba(0,0,0,.22); }
      #demo-cap.on { opacity: 1; transform: translate(-50%, 0); }
      #demo-cap b { color: ${C.volt}; font-weight: 700; }
    \`;
    const add = () => {
      document.head.appendChild(css);
      const c = document.createElement('div'); c.id = 'demo-cursor';
      c.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2l15 9-7 1.6L7.5 20z" fill="${C.ink}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
      const cap = document.createElement('div'); cap.id = 'demo-cap';
      document.body.append(c, cap);
      const pos = JSON.parse(sessionStorage.getItem('demo-pos') || '[720,450]'); c.style.left = pos[0] + 'px'; c.style.top = pos[1] + 'px';
      addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; sessionStorage.setItem('demo-pos', JSON.stringify([e.clientX, e.clientY])); }, true);
      addEventListener('mousedown', () => c.classList.add('down'), true);
      addEventListener('mouseup', () => c.classList.remove('down'), true);
      new MutationObserver(() => { if (document.body.lastElementChild !== cap) document.body.append(c, cap); }).observe(document.body, { childList: true });
    };
    if (document.body) add(); else addEventListener('DOMContentLoaded', add);
  })();
`;

const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
await page.evaluateOnNewDocument(OVERLAY);
if (process.env.DEBUG) { page.on('requestfailed', (r) => console.log('FAIL', r.url(), r.failure()?.errorText)); page.on('response', (r) => r.url().includes(':8200') && console.log('R', r.status(), r.url())); }

async function caption(html, hold = 0) {
  await page.evaluate((h) => { const cap = document.getElementById('demo-cap'); if (!cap) return; if (!h) return cap.classList.remove('on'); cap.innerHTML = h; cap.classList.add('on'); }, html);
  if (hold) await sleep(hold);
}
let mouse = { x: 720, y: 450 };
async function moveTo(x, y, steps = 24) {
  const from = { ...mouse };
  for (let i = 1; i <= steps; i++) { const t = i / steps; const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e); await sleep(12); }
  mouse = { x, y };
}
/** Finds a visible element by css + (partial or exact) text, or by the text of its <label>; scrolls it into view; returns its centre. */
const FIND = `(s, t, exact, label) => {
  const ok = (e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
  if (label) { const l = [...document.querySelectorAll('label')].find((x) => x.textContent.trim().startsWith(t) && x.control && ok(x.control)); return l ? l.control : null; }
  return [...document.querySelectorAll(s)].find((e) => ok(e) && (t == null || (exact ? e.textContent.trim() === t : e.textContent.includes(t)))) || null;
}`;
async function locate(selector, text, exact = false, label = false) {
  const args = [selector, text ?? null, exact, label];
  await page.waitForFunction(`(${FIND})(...${JSON.stringify(args)}) !== null`, { timeout: 60000 });
  await page.evaluate(`(() => { const el = (${FIND})(...${JSON.stringify(args)}); const r = el.getBoundingClientRect(); if (r.top < 0 || r.bottom > innerHeight) el.scrollIntoView({ block: 'center', behavior: 'instant' }); })()`);
  await sleep(120);
  return page.evaluate(`(() => { const r = (${FIND})(...${JSON.stringify(args)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
}
async function clickOn(selector, text, o = {}) { const { x, y } = await locate(selector, text, o.exact); await moveTo(x, y); await sleep(o.pause ?? 200); await page.mouse.down(); await sleep(80); await page.mouse.up(); }
async function typeInto(label, text, delay = 38) {
  const { x, y } = await locate('input', label, false, true); await moveTo(x, y); await page.mouse.down(); await sleep(60); await page.mouse.up();
  await page.evaluate(() => document.activeElement.select?.()); await page.keyboard.press('Backspace');
  if (!delay) await page.keyboard.type(text); else for (const ch of text) { await page.keyboard.type(ch); await sleep(delay); }
}
async function typeAria(aria, text, delay = 45) {
  const { x, y } = await locate(`[aria-label="${aria}"]`); await moveTo(x, y); await page.mouse.down(); await sleep(60); await page.mouse.up();
  for (const ch of text) { await page.keyboard.type(ch); await sleep(delay); }
}
const settle = async () => { await page.waitForNetworkIdle({ idleTime: 300, timeout: 5000 }).catch(() => {}); await sleep(250); };
const visit = async (hash, hold = 900) => { await page.goto(`${ADMIN}/#/${hash}`, { waitUntil: 'load' }).catch(() => {}); await settle(); await sleep(hold); };
async function pickLocation(name) { await clickOn('aside[aria-label="Locations"] button', name); await sleep(1200); }

async function slide(html) {
  await page.setContent(`<!doctype html><html><head>
    <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800&family=Azeret+Mono:wght@500&display=swap" rel="stylesheet">
    <style>
      html, body { margin: 0; height: 100%; background: ${C.ground}; color: ${C.ink}; font-family: Archivo, system-ui, sans-serif; }
      .s { height: 100%; box-sizing: border-box; padding: 64px 80px; display: grid; }
      .lab { font-weight: 600; font-size: 16px; color: ${C.ink3}; }
      h1 { font-size: 128px; line-height: .95; font-weight: 800; letter-spacing: -.04em; margin: 0; }
      h2 { font-size: 54px; line-height: 1; font-weight: 800; letter-spacing: -.03em; margin: 0; }
      .chips { display: flex; gap: 10px; flex-wrap: wrap; }
      .chips span { background: #fff; border: 1.5px solid ${C.line}; border-radius: 999px; padding: 8px 16px; font-weight: 600; font-size: 16px; }
      .chips span.v { background: ${C.volt}; border-color: ${C.volt}; color: ${C.ink}; }
      .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
      .card { border-radius: 12px; padding: 22px; background: #fff; border: 1.5px solid ${C.line}; display: grid; gap: 10px; align-content: start; }
      .num { font-family: 'Azeret Mono', monospace; font-size: 44px; font-weight: 500; letter-spacing: -.03em; line-height: 1; }
      ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 12px; font-size: 21px; }
      li::before { content: '✓'; color: ${C.ok}; font-weight: 800; margin-right: 12px; }
      .mk { width: 76px; height: 76px; border-radius: 16px; background: ${C.ink}; display: grid; place-items: center; }
    </style></head><body>${html}</body></html>`, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
}
const MARK = `<div class="mk"><svg width="40" height="40" viewBox="0 0 32 32"><path d="M5 22h22" stroke="${C.volt}" stroke-width="3.4" stroke-linecap="round"/><rect x="7" y="9" width="5" height="10" rx="1.2" fill="#fff"/><rect x="14" y="6" width="5" height="13" rx="1.2" fill="#fff"/><rect x="21" y="11" width="5" height="8" rx="1.2" fill="#fff"/></svg></div>`;

const clips = [];
async function still(name, html, seconds) { await page.setViewport({ width: W, height: H }); await slide(html); await sleep(400); const path = `${OUT}${name}.png`; await page.screenshot({ path }); clips.push({ path, seconds }); console.log(`✓ ${name}`); }
async function record(name, fn, viewport = { width: W, height: H }) {
  const path = `${OUT}${name}.webm`;
  if (process.env.REUSE && existsSync(path) && !existsSync(`${OUT}${name}-FAILED.png`)) { clips.push({ path }); console.log(`= ${name} (reused)`); return; }
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
  const rec = await page.screencast({ path });
  try { await fn(); } catch (err) { await page.screenshot({ path: `${OUT}${name}-FAILED.png` }); console.error(`✗ ${name} at ${page.url()}`); throw err; } finally { await rec.stop(); }
  clips.push({ path }); console.log(`✓ ${name}`);
}
const adminLogin = async () => {
  await page.goto(`${ADMIN}/`, { waitUntil: 'load' }); await typeInto('Email', 'elena@kestrel.test', 25); await typeInto('Password', 'kestrel-demo-2026', 20);
  await clickOn('button', 'Sign in'); await page.waitForSelector('.domains', { timeout: 30000 }); await settle();
};

/* ---------------------------------------------------------------------- */
await still('01-title', `<div class="s" style="align-content:center;gap:34px">
  ${MARK}
  <h1>Shelfline</h1>
  <div style="font-size:30px;line-height:1.25;max-width:1000px">Multi-location retail and POS. The till keeps selling when the network drops, and every stock, cash and commission figure traces back to a receipt.</div>
  <div class="chips"><span class="v">Offline-first iPad POS</span><span>Stock ledger</span><span>Purchasing</span><span>Rosters and punches</span><span>Commission</span><span>Online store and Shopify</span><span>Xero export</span><span>Per-organisation row security</span><span>Synthetic demo: Kestrel Run Co.</span></div>
</div>`, 5);

await record('02-till-offline', async () => {
  await page.goto(`${POS}/`, { waitUntil: 'load' }); await settle();
  await caption('The iPad till pairs once with a <b>device key</b>', 1600);
  await typeInto('Server address', till.apiUrl, 0); await typeInto('Device key', till.deviceKey, 0); if (process.env.DEBUG) console.log('values', await page.evaluate(() => [...document.querySelectorAll('input')].map((i) => i.value)));
  await clickOn('button', 'Pair this iPad', { exact: true });
  await typeInto('Employee code', till.employeeCode, 60);
  for (const c of till.pin) await clickOn('[aria-label="Number pad"] button', c, { exact: true, pause: 90 });
  if (process.env.DEBUG) console.log('onLine', await page.evaluate(() => navigator.onLine));
  await clickOn('button[aria-label="Sign in"]');
  await page.waitForFunction(() => document.body.textContent.includes('Open the register'), { timeout: 60000 }); await caption('Count the drawer to open the register', 1500);
  await clickOn('button[aria-label="Increase a$100 count"]'); await clickOn('button[aria-label="Increase a$50 count"]'); await clickOn('button', 'Open register with');
  await page.waitForSelector('[aria-label="Scan barcode or search products"]'); await settle();
  await caption('Ring up a sale: <b>price book, promotions and GST</b> are calculated on the device', 1800);
  for (const q of ['Glide 1', 'Gel Citrus']) { await typeAria('Scan barcode or search products', q); await sleep(500); await clickOn('[data-testid="result"]'); await sleep(300); }
  await clickOn('button', 'Pay A$'); await sleep(400); await clickOn('button', 'Exact'); await clickOn('button', 'Complete sale'); await sleep(1800);
  await caption('Sent to the server in the background. Now the <b>network drops</b>', 2200);
  await page.setOfflineMode(true); await page.waitForFunction(() => document.querySelector('[data-testid="sync-pill"]')?.textContent.includes('Offline'), { timeout: 20000 });
  await clickOn('button', 'New sale').catch(() => {}); await sleep(500);
  await caption('Offline: <b>the till keeps selling</b>, stock counts down locally', 2400);
  await typeAria('Scan barcode or search products', 'Crew sock 1'); await sleep(500); await clickOn('[data-testid="result"]'); await sleep(300);
  await clickOn('button', 'Pay A$'); await sleep(400); await clickOn('button', 'Exact'); await clickOn('button', 'Complete sale');
  await page.waitForFunction(() => document.body.textContent.includes('Waiting to send'), { timeout: 20000 }); await caption('The sale is saved on the iPad and <b>queued with an id</b>', 2800);
  await page.setOfflineMode(false); await caption('Back online: the queue drains <b>once, in order</b>', 1000);
  await page.waitForFunction(() => !document.querySelector('[data-testid="sync-pill"]')?.textContent.includes('saved') && !document.querySelector('[data-testid="sync-pill"]')?.textContent.includes('Offline'), { timeout: 40000 });
  await sleep(1500); await caption('', 200);
}, { width: 1180, height: 820 });

await record('03-admin-live', async () => {
  await adminLogin();
  await visit('today/overview', 800); await caption('The back office: <b>today across every store</b>, updated live', 2800);
  await clickOn('a', 'Registers & sessions'); await settle(); await caption('Each register session: <b>expected vs counted cash</b>, variance reviewed by a manager', 3200);
  await clickOn('a', 'Alerts'); await settle(); await caption('Anything the till sent that the server disagrees with becomes a <b>flag, never a lost sale</b>', 3400);
  await visit('sell/orders', 500); await caption('Orders carry their sync flags: price mismatch, negative stock, late sale', 2800);
  await caption('', 200);
});

await record('04-stock-and-buying', async () => {
  await visit('stock/inventory', 600); await caption('One <b>append-only stock ledger</b>: every on-hand number is the sum of its movements', 3200);
  await visit('stock/purchase-orders', 600); await caption('Purchase orders receive in parts, with freight spread into <b>landed cost</b>', 2800);
  await clickOn('tbody tr', null, { pause: 300 }); await settle(); await sleep(2200);
  await visit('money/bills', 600); await caption('Supplier bills are matched to what arrived: over-billed or off-price bills are <b>held</b>', 3200);
  await visit('stock/transfers', 600); await caption('Transfers run through a transit location; blind counts post only the difference', 3000);
  await visit('stock/pricing', 600); await caption('Price books and promotions priced <b>identically on the till and the server</b>', 3000);
  await caption('', 200);
});

await record('05-people', async () => {
  await visit('people/schedule', 500); await pickLocation('Fitzroy'); await caption('Rosters per location, published to staff, with <b>days below the staffing need</b> flagged', 3200);
  await visit('people/timesheets', 500); await caption('Timesheets are built from clock-in and out punches: late, <b>forgotten clock-out</b>, corrections as new punches', 3600);
  await visit('people/terminals', 500); await caption('A fingerprint terminal reports through a small <b>Go bridge</b> on the store network. No fingerprint template ever reaches Shelfline', 4200);
  await caption('', 200);
});

await record('06-commission', async () => {
  await visit('money/commission-rules', 600); await caption('Commission rules are <b>versioned</b>: each sale keeps the rate in force on its own day', 3200);
  await typeAria('Product', 'Glide 1'); await sleep(700); await clickOn('[role="option"]'); await sleep(1200);
  await caption('Try a sale before it happens: the rule, the GST taken out and <b>what it pays</b>', 3600);
  await visit('money/commission', 600); await caption('Statements per period: earned, <b>clawed back on refunds</b>, adjustments', 3200);
  await clickOn('tbody tr button', null); await settle(); await caption('Every dollar traces to a receipt line and the rule version that paid it', 3600);
  await caption('', 200);
});

await record('07-running-the-business', async () => {
  await visit('today/inbox', 600); await caption('An inbox for what needs a person: <b>exceptions, approvals, low stock</b>', 3000);
  await visit('admin/notifications', 600); await caption('Who is told what, by email, and when: <b>per person, per event</b>', 3000);
  await visit('admin/end-of-day', 600); await caption('End-of-day reports go out on time in <b>each store\'s own clock</b>, labelled provisional or amended', 3600);
  await visit('admin/devices', 600); await caption('Receipt printers and card readers register here; the bridge prints, the till never waits for paper', 3200);
  await visit('money/report-access', 600); await caption('Outsiders (an accountant, a landlord) get a <b>clamped, expiring, read-only</b> report portal', 3400);
  await caption('', 200);
});

await record('08-online-and-growth', async () => {
  await visit('sell/online', 600); await caption('Online store: shoppers <b>reserve stock at a store</b> and pay at the counter; the till takes the goods out once', 3800);
  await visit('sell/channels', 600); await caption('A Shopify channel: Shelfline stays the <b>master of stock</b>, signed webhooks are taken once, drift is reconciled', 3800);
  await visit('grow/campaigns', 600); await caption('Campaigns go <b>only to people who said yes</b>, and every email carries a one-click unsubscribe', 3400);
  await visit('grow/loyalty', 600); await caption('Loyalty points are a ledger: earned inside the sale, <b>taken back inside the refund</b>', 3200);
  await caption('', 200);
});

await record('09-books-and-reordering', async () => {
  await visit('money/accounting', 800); await caption('Each closed day becomes a <b>balanced journal</b> for the books', 3000);
  await clickOn('button[aria-label^="Open 20"]', null).catch(() => {}); await settle(); await caption('Send it to Xero as a draft, or download a CSV. Later changes go as <b>adjustments only</b>', 3800);
  await visit('stock/reorder', 800); await caption('What will run short <b>before each supplier can deliver</b>, from real sales and their lead times', 3600);
  await clickOn('button', 'Create draft orders').catch(() => {}); await settle(); await caption('One draft purchase order per supplier. <b>Nothing is sent</b> until a person says so', 3400);
  await caption('', 200);
});

await record('10-hardening', async () => {
  await visit('admin/sso', 800); await caption('Single sign-on with your identity provider. <b>Signing in never creates an account</b>', 3600);
  await caption('', 200);
});

await still('11-hardening', `<div class="s" style="align-content:center;gap:30px">
  <div style="display:flex;justify-content:space-between;align-items:end"><h2>Several organisations, one database, no leaks.</h2><span class="lab">M24 · hardening</span></div>
  <ul>
    <li>Postgres row-level security: the app\'s own database role <b>cannot</b> see another organisation\'s rows, even with a missing filter in the code</li>
    <li>An isolation test walks every table, in both directions, with data in two organisations: zero leaks</li>
    <li>A backup is only a backup once restored: a dump is restored into a fresh database and <b>every row is hashed and compared</b></li>
    <li>Performance budgets run in the test suite; dependencies are audited by script; the Go bridge uses only the standard library</li>
  </ul>
  <div class="chips"><span class="v">Row-level security</span><span>OpenID Connect sign-in</span><span>Two terminal dialects</span><span>Backup restore proof</span><span>p95 budgets</span></div>
</div>`, 7);

await still('12-results', `<div class="s" style="align-content:center;gap:30px">
  <div style="display:flex;justify-content:space-between;align-items:end"><h2>Proven by tests, not claimed.</h2><span class="lab">24 of 24 milestones built</span></div>
  <div class="grid">
    <div class="card"><div class="num">5,030</div><div class="lab">sync commands through a network that drops and repeats requests: each counted exactly once; replay gives identical ledger and cash checksums</div></div>
    <div class="card"><div class="num">440</div><div class="lab">golden pricing vectors shared by the till and the server, so offline totals match</div></div>
    <div class="card"><div class="num">A$8.00</div><div class="lab">A$219.95 at 4% of the sale without GST; a full refund takes it back to exactly zero, for every person</div></div>
    <div class="card"><div class="num">0</div><div class="lab">lost sales or cash differences after replaying the whole history into an empty database</div></div>
  </div>
  <ul>
    <li>Stock, cash, gift-card balances, receipts and closed commission periods are append-only, enforced by database triggers</li>
    <li>Two tills spending one gift card at once are ordered; the overspend is flagged, not hidden</li>
    <li>Terminals, printers, Shopify, Xero and single sign-on are tested against stand-ins; every real-world claim stays labelled unverified</li>
  </ul>
  <div class="chips"><span>NestJS</span><span>Postgres</span><span>React + Vite</span><span>Go bridge</span><span>~1,000 tests</span><span>63 browser e2e</span><span>github.com/geffaa/shelfline</span></div>
</div>`, 9);

await browser.close();
const parts = clips.flatMap((c) => (c.seconds ? ['-loop', '1', '-framerate', '30', '-t', String(c.seconds), '-i', c.path] : ['-i', c.path]));
const filter = clips.map((_, i) => `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0xECEFF2,fps=30,setsar=1[v${i}]`).join(';') + ';' + clips.map((_, i) => `[v${i}]`).join('') + `concat=n=${clips.length}:v=1:a=0[out]`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...parts, '-filter_complex', filter, '-map', '[out]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `${OUT}shelfline-demo.mp4`]);
console.log(`→ ${OUT}shelfline-demo.mp4`);
