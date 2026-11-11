import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Minus, Plus } from "lucide-react";
import { Button, Callout, Checkbox, Chip, Segmented, Select, Stepper } from "@shelfline/ui";
import { api, ApiError, qs } from "../lib/api";
import { money } from "../lib/format";
import { useAuth } from "../state/auth";
import { useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, PageHeader, Panel, Skeleton } from "../ui";

interface Sug { variantId: string; sku: string; title: string; onHand: number; incoming: number; avgDaily: number; reorderPoint: number; target: number; qty: number; reason: "out_of_stock" | "below_reorder_point"; supplier: string | null; supplierId: string | null; leadTimeDays: number; unitCostMinor: number | null; costMinor: number }
interface Res { location: string; scope: string; suggestions: Sug[]; withoutSupplier: number }

export function Reorder() {
  useLensLock(false);
  const { can } = useAuth(); const { locations, selected } = useLens(); const write = can("purchase:write", null);
  const [loc, setLoc] = useState<string | null>(null); const [scope, setScope] = useState<"location" | "network">("location");
  const locationId = loc ?? selected?.id ?? locations.find((l) => l.type === "store")?.id;
  const q = useQuery({ queryKey: ["reorder", locationId, scope], enabled: !!locationId, queryFn: () => api<Res>(`/replenishment${qs({ locationId, scope })}`) });
  const [off, setOff] = useState<Set<string>>(new Set()); const [qty, setQty] = useState<Record<string, number>>({}); const [key, setKey] = useState(() => crypto.randomUUID()); const [done, setDone] = useState<number | null>(null); const [err, setErr] = useState<string | null>(null);
  const rows = q.data?.suggestions ?? []; const orderable = rows.filter((r) => r.supplierId); const chosen = orderable.filter((r) => !off.has(r.variantId));
  const q_ = (r: Sug) => qty[r.variantId] ?? r.qty; const total = chosen.reduce((a, r) => a + q_(r) * (r.unitCostMinor ?? 0), 0);
  const make = useMutation({
    mutationFn: () => api<{ poIds: string[] }>("/replenishment/draft-pos", { method: "POST", body: { locationId, key, lines: chosen.map((r) => ({ variantId: r.variantId, supplierId: r.supplierId, qty: q_(r), unitCostMinor: r.unitCostMinor ?? 0 })) } }),
    onSuccess: (r) => { setDone(r.poIds.length); setKey(crypto.randomUUID()); },
    onError: (e) => setErr(e instanceof ApiError && e.status === 403 ? "You do not have permission to create purchase orders." : "Could not create the draft orders."),
  });
  const bySupplier = useMemo(() => new Set(chosen.map((r) => r.supplierId)).size, [chosen]);
  return (<>
    <PageHeader title="Reorder" sub="What will run short before your suppliers can deliver, based on recent sales" />
    <div className="filters"><Select label="Location" value={locationId ?? null} onChange={(v) => { setLoc(v); setDone(null); setOff(new Set()); setQty({}); }} options={locations.map((l) => ({ value: l.id, label: l.name }))} chevron={<ChevronDown size={16} />} />
      <Segmented label="Stock counted" value={scope} onChange={(v) => { setScope(v); setDone(null); }} options={[{ value: "location", label: "This location" }, { value: "network", label: "Whole network" }]} /></div>
    {done !== null && <Callout tone="info">{done} draft order{done === 1 ? "" : "s"} created. Review and send them under <a href="#/stock/purchase-orders">Purchase orders</a>.</Callout>}
    {q.data && q.data.withoutSupplier > 0 && <Callout tone="warn">{q.data.withoutSupplier} product{q.data.withoutSupplier === 1 ? " has" : "s have"} no supplier on record yet. Raise a first order for {q.data.withoutSupplier === 1 ? "it" : "them"} from Purchase orders.</Callout>}
    <Panel flush right={write && <Button variant="primary" disabled={!chosen.length || make.isPending} onClick={() => { setErr(null); make.mutate(); }}>Create draft orders{chosen.length ? ` (${bySupplier})` : ""}</Button>}>
      {q.isLoading || !locationId ? <Skeleton rows={5} /> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : rows.length === 0 ? <Empty title="Nothing to reorder">Stock covers expected sales until the next delivery.</Empty> : (
        <div className="tbl-wrap"><table className="tbl" data-testid="reorder-table"><thead><tr><th>Order</th><th>Product</th><th className="n">On hand</th><th className="n">On order</th><th className="n">Sells / day</th><th className="n">Reorder at</th><th>Supplier</th><th className="n">Quantity</th><th className="n">Cost</th></tr></thead>
          <tbody>{rows.map((r) => { const can_ = !!r.supplierId; return (
            <tr key={r.variantId}><td>{can_ ? <Checkbox checked={!off.has(r.variantId)} onChange={(on) => { const n = new Set(off); if (on) n.delete(r.variantId); else n.add(r.variantId); setOff(n); }} checkIcon={<Check size={14} />}><span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Order {r.sku}</span></Checkbox> : <span className="muted">—</span>}</td>
              <td><b>{r.title}</b><br /><span className="muted" style={{ fontSize: 12.5 }}>{r.sku}</span> {r.reason === "out_of_stock" && <Chip tone="danger">Out of stock</Chip>}</td>
              <td className="n">{r.onHand}</td><td className="n">{r.incoming || "—"}</td><td className="n">{r.avgDaily}</td><td className="n">{r.reorderPoint}</td>
              <td>{r.supplier ? <>{r.supplier}<br /><span className="muted" style={{ fontSize: 12.5 }}>{r.leadTimeDays} day lead time</span></> : <span className="muted">No supplier</span>}</td>
              <td className="n">{can_ ? <Stepper label={`Quantity of ${r.sku}`} value={q_(r)} min={1} max={99999} onChange={(n) => setQty({ ...qty, [r.variantId]: n })} decrementIcon={<Minus size={16} />} incrementIcon={<Plus size={16} />} /> : r.qty}</td>
              <td className="n">{r.unitCostMinor === null ? "—" : money(q_(r) * r.unitCostMinor)}</td></tr>); })}</tbody>
          {chosen.length > 0 && <tfoot><tr><td colSpan={8}><b>{chosen.length} line{chosen.length === 1 ? "" : "s"} across {bySupplier} supplier{bySupplier === 1 ? "" : "s"}</b></td><td className="n"><b>{money(total)}</b></td></tr></tfoot>}</table></div>
      )}
    </Panel>
    {err && <p className="err" role="alert">{err}</p>}
  </>);
}
