import { useEffect, useState } from "react";
import { Download, RefreshCw, TriangleAlert } from "lucide-react";
import type { FlaggedRecord, RejectionRecord } from "@shelfline/sync-client";
import { Button, Callout, Chip } from "@shelfline/ui";
import { clockTime, fmt } from "../lib/format";
import { download, exportQueue, queueItems, type QueueItem } from "../lib/queue";
import { useApp } from "../state/app";

const REASONS: Record<string, string> = { unknown_variant: "A product on this sale is not in the catalogue.", forbidden: "This person is not allowed to do that.", actor_not_assigned: "The cashier is not assigned to this store.", invalid_payload: "The app sent something the server could not read.", update_required: "This app is too old. Update it and open it again.", unsupported_schema: "This app is newer than the server.", unknown_command: "The server does not know this action.", unknown_sale: "The sale being refunded is not on the server.", unknown_session: "The register session is not on the server.", wrong_register: "That session belongs to another register.", bad_amount: "The amount is not valid." };
const FLAGS: Record<string, string> = { negative_stock: "Stock went below zero", price_mismatch: "Totals differed from the server", discount_unapproved: "Discount above the limit without approval", late_sale: "Arrived after the register closed", no_session: "No open register session", receipt_no_reused: "Receipt number was already used", payment_mismatch: "Payments did not match the total", unknown_customer: "Customer not found", skewed_clock: "This iPad's clock is off", merge_candidate: "Possible duplicate customer", session_force_closed: "An older register session was closed", over_refund: "More refunded than sold", variance_over_limit: "Cash count off by more than the limit", refund_unapproved: "Refund without approval", no_sale_no_reason: "No-sale without a reason", punch_repeat: "Repeated clock punch" };

export function SyncScreen() {
  const { sync, syncNow, problems, device, store, catalogue, signOut, unpair } = useApp();
  const [p, setP] = useState<{ rejections: RejectionRecord[]; flagged: FlaggedRecord[] }>({ rejections: [], flagged: [] }); const [queue, setQueue] = useState<QueueItem[]>([]);
  useEffect(() => { void problems().then(setP); void queueItems(store).then(setQueue); }, [problems, store, sync.queued, sync.lastSyncAt]);
  const skew = sync.clockSkewMs ?? null;
  return (
    <section className="pos-main" style={{ gridRow: "2 / 3", gridColumn: "2 / 4", overflow: "auto", display: "block" }} aria-label="Sync status">
      <div className="stack" style={{ maxWidth: 820 }}>
        <div className="row-flex"><h1 style={{ margin: 0, fontSize: 26 }}>Sync</h1><span className="grow" /><Button variant="primary" onClick={() => void syncNow()} disabled={sync.state === "syncing"}><RefreshCw size={16} />Sync now</Button></div>
        <div className="panel"><div className="pb">
          <div className="lead"><span>Connection</span><i /><b data-testid="conn-state">{sync.state === "offline" ? "Offline" : sync.state === "syncing" ? "Syncing…" : "Online"}</b></div>
          <div className="lead"><span>Waiting to send</span><i /><b data-testid="queued-count">{sync.queued}</b></div>
          <div className="lead"><span>Last sync</span><i /><b>{sync.lastSyncAt ? clockTime(new Date(sync.lastSyncAt)) : "never"}</b></div>
          <div className="lead"><span>iPad clock vs server</span><i /><b className={skew !== null && Math.abs(skew) > 300_000 ? "neg" : ""}>{skew === null ? "not measured" : Math.round(Math.abs(skew) / 1000) === 0 ? "in step" : `${skew >= 0 ? "+" : "−"}${Math.round(Math.abs(skew) / 1000)} s`}</b></div>
          <div className="lead"><span>Store</span><i /><b>{catalogue?.location?.name ?? "—"}</b></div>
          <div className="lead"><span>Register</span><i /><b>{catalogue?.register?.code ?? "—"}</b></div>
          <div className="lead"><span>Server</span><i /><b style={{ fontSize: 12 }}>{device?.apiUrl}</b></div>
        </div></div>
        {skew !== null && Math.abs(skew) > 300_000 && <Callout tone="warn" icon={<TriangleAlert size={18} />}>This iPad's clock is more than five minutes off. Sales are still recorded, but the server will use its own time and flag them. Set the iPad to automatic date and time.</Callout>}
        {sync.seqDivergence && <Callout tone="danger" icon={<TriangleAlert size={18} />}>This iPad's queue and the server's disagree (storage may have been cleared). Tell a manager before closing the register.</Callout>}
        {sync.error && sync.state === "offline" && <p className="muted" style={{ margin: 0 }}>Last problem: {sync.error}</p>}
        <div className="panel"><header><h2>Waiting to send ({queue.length})</h2><Button size="sm" onClick={async () => { if (device) download(`shelfline-unsent-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`, await exportQueue(store, device.apiUrl)); }} disabled={queue.length === 0}><Download size={14} />Export unsent</Button></header><div className="pb" data-testid="queue-list">
          {queue.length === 0 ? <span className="muted">Everything has been sent.</span> : queue.map((q) => <div key={q.id} className="lead"><span>#{q.seq} · <b>{q.label}</b> <span className="muted">{q.detail} · {clockTime(new Date(q.at))}</span></span><i /><b>{q.amountMinor !== undefined ? (q.amountMinor / 100).toFixed(2) : ""}</b></div>)}
          {queue.length > 0 && <p className="muted" style={{ margin: "12px 0 0", fontSize: 12.5 }}>If this iPad's storage is in doubt, export the unsent items and give the file to a technician; they can load it into the server with the import tool.</p>}</div></div>
        <div className="panel"><header><h2>Refused by the server ({p.rejections.length})</h2></header><div className="pb">
          {p.rejections.length === 0 ? <span className="muted">Nothing refused.</span> : p.rejections.map((r) => <div key={r.id} className="lead" style={{ alignItems: "start" }}><span><b>{r.type}</b> #{r.seq}<br /><span className="muted">{REASONS[r.reason] ?? r.reason}</span></span><i /><Chip tone="danger">Refused</Chip></div>)}</div></div>
        <div className="panel"><header><h2>Accepted with a note ({p.flagged.length})</h2></header><div className="pb">
          {p.flagged.length === 0 ? <span className="muted">Nothing to review.</span> : p.flagged.map((f) => <div key={f.id} className="lead" style={{ alignItems: "start" }}><span><b>{f.type}</b> #{f.seq}<br /><span className="muted">{f.flags.map((x) => FLAGS[x] ?? x).join(" · ")}</span></span><i /><Chip tone="warn">Review</Chip></div>)}</div></div>
        <div className="row-flex"><Button onClick={signOut}>Sign out</Button><Button variant="ghost" onClick={() => { if (confirm("Unpair this iPad? Sales not yet sent stay on the iPad.")) unpair(); }}>Unpair</Button></div>
        <span hidden>{fmt(0)}</span>
      </div>
    </section>
  );
}

/** Shown instead of the till when the server says this app version is too old (or refused a command for that reason). Nothing is lost: the queue stays on the iPad. */
export function UpdateRequired() {
  const { sync, device, store } = useApp();
  const reload = async () => { try { const regs = await navigator.serviceWorker?.getRegistrations(); await Promise.all((regs ?? []).map((r) => r.update())); } finally { window.location.reload(); } };
  return (
    <main className="screen-center"><div className="card-auth">
      <h1>Update required</h1>
      <p style={{ margin: 0 }}>The server no longer accepts this version of the till app. {sync.queued > 0 ? <b>{sync.queued} unsent item{sync.queued === 1 ? " is" : "s are"} saved safely on this iPad.</b> : "Nothing is waiting to be sent."}</p>
      <p className="muted" style={{ margin: 0 }}>Connect to the internet and reload. The new version installs itself, then your saved items send automatically.</p>
      <Button variant="primary" size="lg" onClick={() => void reload()}>Reload and update</Button>
      {sync.queued > 0 && device && <Button onClick={async () => download("shelfline-unsent.json", await exportQueue(store, device.apiUrl))}><Download size={14} />Export unsent items</Button>}
    </div></main>
  );
}
