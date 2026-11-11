import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, Banknote, Calendar, Check, ChevronLeft, ChevronRight, Fingerprint, LockOpen, RotateCcw, SquareDashed, TriangleAlert, Wallet } from "lucide-react";
import { Button, Chip, DatePicker } from "@shelfline/ui";
import { api, qs } from "../lib/api";
import { addDays, flagLabel, money, plain, time, todayYmd } from "../lib/format";
import { href, navigate, useRoute } from "../router";
import { useAuth } from "../state/auth";
import { useBusinessToday, useLens, useTz } from "../state/lens";
import { Empty, ErrorBox, FlagChips, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface Row { id: string; register: string; cashier: string; openedAt: string; closedAt: string | null; status: string; salesCount: number; netSalesMinor: number; expectedMinor: number; varianceMinor: number | null; flags: string[]; reviewedAt: string | null; location?: string; locationId?: string }
interface Z { expectedMinor: number; salesCount: number; grossSalesMinor: number; refundsMinor: number; netSalesMinor: number; gstMinor: number; noSaleCount: number; tenders: { cashMinor: number; cardMinor: number; otherMinor: number }; cash: { salesMinor: number; salesCount: number; refundsMinor: number; payInMinor: number; payOutMinor: number; dropMinor: number; floatAddMinor: number } }
interface Detail { id: string; register: string; locationId: string; status: string; openedAt: string; openedBy: string | null; closedAt: string | null; openingFloatMinor: number; countedMinor: number | null; expectedAtCloseMinor: number | null; varianceMinor: number | null; flags: string[]; reviewedAt: string | null; reviewNote: string | null; z: Z | null; changedSinceClose: boolean; events: { at: string; kind: string; actor: string; amountMinor?: number; reason?: string | null; flags?: string[]; ref?: string }[] }

const EV: Record<string, { label: string; icon: React.ReactNode; tone?: string }> = {
  clock_in: { label: "Clocked in", icon: <Fingerprint /> }, clock_out: { label: "Clocked out", icon: <Fingerprint /> }, register_opened: { label: "Register opened", icon: <LockOpen /> }, register_closed: { label: "Register closed", icon: <Wallet /> },
  pay_in: { label: "Pay-in", icon: <ArrowDownToLine /> }, pay_out: { label: "Pay-out", icon: <ArrowUpFromLine /> }, drop: { label: "Safe drop", icon: <Banknote /> }, float_add: { label: "Float added", icon: <ArrowDownToLine /> }, no_sale: { label: "No sale", icon: <SquareDashed /> }, refund: { label: "Refund", icon: <RotateCcw /> },
};

function CloseSheet({ d }: { d: Detail }) {
  const z = d.z; if (!z) return null;
  const L = ({ l, v, neg, total, sub, cls }: { l: React.ReactNode; v: number; neg?: boolean; total?: boolean; sub?: boolean; cls?: string }) => <div className={`lead${total ? " total" : ""}${sub ? " sub" : ""}${(neg && v) || cls === "neg" ? " neg" : ""}`}><span>{l}</span><i /><b>{neg && v ? plain(-v) : plain(v)}</b></div>;
  return (<>
    <L l="Opening float" v={d.openingFloatMinor} />
    <L l={<>Cash sales <span className="muted">({z.cash.salesCount})</span></>} v={z.cash.salesMinor} /><L l="Cash refunds" v={z.cash.refundsMinor} neg /><L l="Pay-ins and float" v={z.cash.payInMinor + z.cash.floatAddMinor} /><L l="Pay-outs" v={z.cash.payOutMinor} neg /><L l="Safe drops" v={z.cash.dropMinor} neg />
    <L l="Expected in drawer" v={d.expectedAtCloseMinor ?? z.expectedMinor} total />
    {d.countedMinor !== null && <><L l="Counted at close" v={d.countedMinor} /><div className={`lead${d.varianceMinor ? " neg" : ""}`}><span><b>Variance</b></span><i /><b data-testid="variance">{plain(d.varianceMinor ?? 0)}</b></div></>}
    <hr className="perf" />
    <L l="Cash" v={z.tenders.cashMinor} /><L l="Card" v={z.tenders.cardMinor} />{z.tenders.otherMinor > 0 && <L l="Other" v={z.tenders.otherMinor} />}
    <L l={<>Gross sales <span className="muted">({z.salesCount})</span></>} v={z.grossSalesMinor} /><L l="Refunds" v={z.refundsMinor} neg /><L l="Net sales" v={z.netSalesMinor} total /><L l="GST included" v={z.gstMinor} sub />
  </>);
}

function SessionDetail({ id }: { id: string }) {
  const tzOf = useTz();
  const { can } = useAuth(); const qc = useQueryClient(); const [note, setNote] = useState("");
  const q = useQuery({ queryKey: ["session", id], queryFn: () => api<Detail>(`/sessions/${id}`) });
  const review = useMutation({ mutationFn: () => api(`/sessions/${id}/review`, { method: "POST", body: { note } }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["session", id] }); void qc.invalidateQueries({ queryKey: ["sessions"] }); setNote(""); } });
  if (q.isLoading) return <Panel><Skeleton rows={8} /></Panel>; if (q.isError) return <ErrorBox error={q.error} retry={() => q.refetch()} />; const d = q.data!;
  const needsReview = !d.reviewedAt && (d.flags.includes("variance_over_limit") || d.flags.includes("needs_review") || (d.varianceMinor ?? 0) !== 0);
  return (<>
    {d.status !== "open" && needsReview && <div className="callout" role="status"><TriangleAlert size={18} /><div><b>{d.register} needs review.</b> {d.varianceMinor ? `Closed with a variance of ${plain(d.varianceMinor)}. ` : ""}{d.events.filter((e) => e.kind === "no_sale" && e.flags?.includes("no_sale_no_reason")).length ? "A no-sale has no reason recorded. " : ""}{d.flags.map(flagLabel).join(", ")}</div></div>}
    {d.changedSinceClose && <div className="callout info"><div><b>Changed since close.</b> Sales or cash entries arrived after the count; the live figures differ from the figures at close.</div></div>}
    <div className="split">
      <Panel title={`${d.register} close sheet`} right={<span className="chip">{d.openedBy} · {d.status === "open" ? "open" : d.status === "force_closed" ? "force-closed" : "counted blind"}</span>}><CloseSheet d={d} /></Panel>
      <Panel title="What happened" right={<span className="muted">store local time</span>}>
        <ul className="tl">{d.events.map((e, i) => { const m = EV[e.kind] ?? { label: e.kind, icon: <Check /> }; const bad = !!e.flags?.some((f) => f.endsWith("no_reason") || f === "variance_over_limit" || f === "over_refund"); const warn = !!e.flags?.length;
          return <li key={i}><span className="t">{time(e.at, tzOf(d.locationId))}</span><span className="k"><span className={`ic ${bad ? "danger" : warn ? "warn" : ""}`}>{m.icon}</span></span><span className="w"><b>{m.label}</b>{e.actor ? ` · ${e.actor}` : ""}{e.amountMinor ? ` · ${money(e.amountMinor)}` : ""}<div className="d">{[e.reason, e.ref && `receipt ${e.ref}`].filter(Boolean).join(" · ")}{e.flags?.length ? <FlagChips flags={e.flags.filter((f) => f !== "needs_review" || e.kind.startsWith("clock"))} /> : null}</div></span></li>; })}</ul>
      </Panel>
    </div>
    {d.reviewedAt ? <Panel title="Reviewed"><span>{d.reviewNote || "Reviewed without a note"} <span className="muted">· {time(d.reviewedAt, tzOf(d.locationId))}</span></span></Panel>
      : d.status !== "open" && can("cash:approve", d.locationId) && <Panel title="Review"><div className="row-flex"><div className="input grow"><input aria-label="Review note" placeholder="Note (for example: recounted, one note short)" value={note} onChange={(e) => setNote(e.target.value)} /></div><Button variant="primary" onClick={() => review.mutate()} disabled={review.isPending}>Mark reviewed</Button></div>{review.isError && <p className="err">Could not save the review.</p>}</Panel>}
  </>);
}

export function Sessions() {
  const tzOf = useTz();
  const route = useRoute(); const { lens, locations, selected } = useLens(); const today = useBusinessToday(); const [picked, setPicked] = useState<string | null>(null); const date = picked ?? today; const setDate = (d: string) => setPicked(d);
  const stores = useMemo(() => (lens === "all" ? locations.filter((l) => l.type !== "warehouse") : locations.filter((l) => l.id === lens)), [lens, locations]);
  const results = useQueries({ queries: stores.map((l) => ({ queryKey: ["sessions", l.id, date], queryFn: () => api<Row[]>(`/sessions${qs({ locationId: l.id, date })}`).then((r) => r.map((x) => ({ ...x, location: l.name, locationId: l.id }))) })) });
  const rows = results.flatMap((r) => r.data ?? []).sort((a, b) => b.openedAt.localeCompare(a.openedAt)); const loading = results.some((r) => r.isLoading);
  const sel = route.id;
  return (<>
    <PageHeader title="Registers & sessions" sub={<>{lens === "all" ? "All locations" : selected?.name} · business day ends at the store's cutoff · AUD</>}
      actions={<><Button variant="ghost" size="sm" aria-label="Previous day" onClick={() => setDate(addDays(date, -1))}><ChevronLeft size={16} /></Button><DatePicker label="Business day" value={date} onChange={setDate} today={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} /><Button variant="ghost" size="sm" aria-label="Next day" onClick={() => setDate(addDays(date, 1))} disabled={date >= today}><ChevronRight size={16} /></Button></>} />
    <Panel title={`Sessions · ${date}`} right={<span className="muted">{rows.length} session{rows.length === 1 ? "" : "s"} · {rows.reduce((a, r) => a + r.salesCount, 0)} orders</span>} flush>
      {loading ? <Skeleton rows={3} /> : rows.length === 0 ? <Empty title="No register sessions on this day">When a till opens a register, its session appears here.</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="sessions-table"><thead><tr><th>Session</th>{lens === "all" && <th>Location</th>}<th>Cashier</th><th>Opened – closed</th><th className="n">Orders</th><th className="n">Net sales</th><th className="n">Cash variance</th><th>Status</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id} className="clickable" tabIndex={0} aria-selected={sel === r.id} onClick={() => navigate("today", "sessions", r.id)} onKeyDown={(e) => { if (e.key === "Enter") navigate("today", "sessions", r.id); }}>
            <td><b>{r.register}</b></td>{lens === "all" && <td>{r.location}</td>}<td>{r.cashier}</td><td className="mono">{time(r.openedAt, tzOf(r.location))} – {r.closedAt ? time(r.closedAt, tzOf(r.location)) : "open"}</td><td className="n">{r.salesCount}</td><td className="n">{plain(r.netSalesMinor)}</td>
            <td className={`n${r.varianceMinor ? " neg" : ""}`}>{r.varianceMinor === null ? <span className="muted">live</span> : plain(r.varianceMinor)}</td>
            <td>{r.status === "open" ? <Chip tone="info"><span className="dot-s ok" />Open</Chip> : r.reviewedAt ? <Chip tone="ok"><Check size={12} />Reviewed</Chip> : r.flags.length || r.varianceMinor ? <Chip tone="warn"><TriangleAlert size={12} />Needs review</Chip> : <Chip tone="ok"><Check size={12} />Balanced</Chip>}</td></tr>)}</tbody></table></div>}
    </Panel>
    {sel ? <SessionDetail id={sel} /> : rows.length > 0 && <Empty title="Pick a session">Choose a row to see its close sheet and what happened during the day.</Empty>}
    <span hidden><TextInput id="x" value="" onChange={() => undefined} /></span>
  </>);
}
void href;
