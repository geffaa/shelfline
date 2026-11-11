import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Chip, DatePicker, Segmented, Select, Switch } from "@shelfline/ui";
import { api, ApiError } from "../lib/api";
import { money } from "../lib/format";
import { useAuth } from "../state/auth";
import { useBusinessToday, useLens, useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";
import { VariantPicker, type VariantHit } from "./buy";

interface Ver { id: string; version: number; validFrom: string; enabled: boolean; basis: "net_ex_tax" | "margin"; rateBp: number; splitMode: string; weights: Record<string, number> }
interface Set { id: string; label: string; scopeKind: string; scopeValue: string | null; inForceId: string | null; versions: Ver[] }
export const SPLITS = [{ value: "seller", label: "Seller keeps it" }, { value: "equal", label: "Equal, everyone clocked in" }, { value: "weighted", label: "Weighted by role" }, { value: "hours_pool", label: "Pool by hours worked" }];
const SCOPES = [{ value: "default", label: "Everything else" }, { value: "location", label: "One location" }, { value: "category", label: "A category" }, { value: "brand", label: "A brand" }, { value: "variant", label: "One product" }];
const ROLES = [["cashier", "Cashier"], ["store_manager", "Store manager"], ["hq_manager", "HQ manager"]] as const;
const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;
const BASIS = { net_ex_tax: "of the sale without GST", margin: "of the margin" } as const;
const splitLabel = (s: string) => SPLITS.find((x) => x.value === s)?.label ?? s;

function Preview() {
  const { locations } = useLens(); const stores = locations.filter((l) => l.type === "store"); const today = useBusinessToday();
  const [v, setV] = useState<VariantHit | null>(null); const [loc, setLoc] = useState<string | null>(stores[0]?.id ?? null); const [total, setTotal] = useState(""); const [date, setDate] = useState(today);
  const cents = Math.round(Number(total.replace(/[^0-9.]/g, "")) * 100) || 0;
  const q = useQuery({ queryKey: ["commission-preview", v?.id, loc, cents, date], enabled: !!v && !!loc && cents > 0, queryFn: () => api<{ rule: { scopeKind: string; version: number; rateBp: number; basis: string; splitMode: string } | null; taxMinor: number; baseMinor: number; commissionMinor: number }>("/commission/preview", { method: "POST", body: { variantId: v!.id, locationId: loc, date, qty: 1, totalMinor: cents } }) });
  return (
    <Panel title="Try a sale">
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>Pick a product and a price to see which rule would apply and what it pays.</p>
        <VariantPicker label="Product" onPick={(x) => { setV(x); if (!total) setTotal((x.basePriceMinor / 100).toFixed(2)); }} />
        {v && <p style={{ margin: 0 }}><b>{v.title}</b> <span className="muted">{v.sku}</span></p>}
        <div className="grid2"><Select label="Location" value={loc} onChange={setLoc} options={stores.map((l) => ({ value: l.id, label: l.name }))} chevron={<ChevronDown size={16} />} />
          <Field id="pv-total" label="Line total with GST (A$)"><TextInput id="pv-total" value={total} onChange={setTotal} inputMode="decimal" placeholder="219.95" /></Field></div>
        <DatePicker label="Sale date" value={date} onChange={setDate} today={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />
        {q.data && (q.data.rule ? <div className="callout info" data-testid="preview-result"><div><b>{money(q.data.commissionMinor)}</b> in total · {pct(q.data.rule.rateBp)} {BASIS[q.data.rule.basis as keyof typeof BASIS]} ({money(q.data.baseMinor)}, GST {money(q.data.taxMinor)} taken out) · {SCOPES.find((s) => s.value === q.data!.rule!.scopeKind)?.label.toLowerCase()} rule, version {q.data.rule.version}, {splitLabel(q.data.rule.splitMode).toLowerCase()}</div></div>
          : <div className="callout warn" data-testid="preview-result"><div>No rule applies to this sale, so it earns nothing.</div></div>)}
      </div>
    </Panel>
  );
}

function Form({ initial, onDone }: { initial?: Set; onDone: () => void }) {
  const qc = useQueryClient(); const { locations } = useLens(); const today = useBusinessToday(); const cur = initial?.versions.find((v) => v.id === initial.inForceId) ?? initial?.versions[0];
  const [kind, setKind] = useState(initial?.scopeKind ?? "default"); const [value, setValue] = useState<string | null>(initial?.scopeValue ?? null); const [variant, setVariant] = useState<VariantHit | null>(null); const [brand, setBrand] = useState(initial?.scopeKind === "brand" ? initial.scopeValue ?? "" : "");
  const [rate, setRate] = useState(cur ? String(cur.rateBp / 100) : "3"); const [basis, setBasis] = useState<"net_ex_tax" | "margin">(cur?.basis ?? "net_ex_tax"); const [split, setSplit] = useState(cur?.splitMode ?? "seller"); const [enabled, setEnabled] = useState(cur?.enabled ?? true);
  const [from, setFrom] = useState(today); const [note, setNote] = useState(""); const [w, setW] = useState<Record<string, string>>(Object.fromEntries(ROLES.map(([k]) => [k, String(cur?.weights[k] ?? 100)]))); const [err, setErr] = useState<string | null>(null);
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => api<{ id: string; name: string }[]>("/categories") });
  const scopeValue = kind === "default" ? null : kind === "brand" ? brand.trim() : kind === "variant" ? variant?.id ?? value : value;
  const bp = Math.round(Number(rate) * 100);
  const save = useMutation({
    mutationFn: () => api("/commission/rules", { method: "POST", body: { scopeKind: kind, scopeValue, validFrom: from, enabled, basis, rateBp: bp, splitMode: split, weights: split === "weighted" ? Object.fromEntries(ROLES.map(([k]) => [k, Math.max(0, Math.round(Number(w[k]) || 0))])) : {}, note: note.trim() || undefined } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["commission-rules"] }); onDone(); },
    onError: (e) => setErr(e instanceof ApiError && e.code === "version_date_taken" ? "This rule already has a version starting that day. Pick another date." : e instanceof ApiError && e.status === 400 ? "Check the rate (0 to 100%) and the scope." : "Could not save the rule."),
  });
  return (
    <Panel title={initial ? `New version of "${initial.label}"` : "New rule"}>
      <form className="stack" aria-label="Commission rule" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        {!initial && <><Select label="Applies to" value={kind} onChange={(k) => { setKind(k); setValue(null); }} options={SCOPES} chevron={<ChevronDown size={16} />} />
          {kind === "location" && <Select label="Location" value={value} onChange={setValue} options={locations.filter((l) => l.type === "store").map((l) => ({ value: l.id, label: l.name }))} placeholder="Choose a location" chevron={<ChevronDown size={16} />} />}
          {kind === "category" && <Select label="Category" value={value} onChange={setValue} options={(cats.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="Choose a category" chevron={<ChevronDown size={16} />} />}
          {kind === "brand" && <Field id="cr-brand" label="Brand"><TextInput id="cr-brand" value={brand} onChange={setBrand} placeholder="Tempra" /></Field>}
          {kind === "variant" && <><VariantPicker label="Product" onPick={setVariant} />{variant && <p style={{ margin: 0 }}><b>{variant.title}</b> <span className="muted">{variant.sku}</span></p>}</>}</>}
        <Switch checked={enabled} onChange={setEnabled}>{enabled ? "Pays commission" : "Pays nothing (excludes this scope from the general rate)"}</Switch>
        {enabled && <><div className="grid2"><Field id="cr-rate" label="Rate (%)"><TextInput id="cr-rate" value={rate} onChange={setRate} inputMode="decimal" /></Field>
          <div className="field-in"><span className="lbl">Paid on</span><Segmented label="Basis" value={basis} onChange={setBasis} options={[{ value: "net_ex_tax", label: "Sale without GST" }, { value: "margin", label: "Margin" }]} /></div></div>
          <Select label="Who gets it" value={split} onChange={setSplit} options={SPLITS} chevron={<ChevronDown size={16} />} />
          {split === "weighted" && <div className="grid2">{ROLES.map(([k, l]) => <Field key={k} id={`cr-w-${k}`} label={`${l} weight`}><TextInput id={`cr-w-${k}`} value={w[k]!} onChange={(x) => setW({ ...w, [k]: x })} inputMode="numeric" /></Field>)}</div>}</>}
        <DatePicker label="Starts on" value={from} onChange={setFrom} today={today} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />
        <p className="muted" style={{ margin: 0 }}>Sales keep the rate that was in force on their own day. This version applies from the date above and never changes the past.</p>
        <Field id="cr-note" label="Note (optional)"><TextInput id="cr-note" value={note} onChange={setNote} /></Field>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button type="button" onClick={onDone}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={save.isPending || !from || (enabled && !(bp >= 0 && bp <= 10000 && rate.trim() !== "")) || (kind !== "default" && !scopeValue)}>Save version</Button></div>
      </form>
    </Panel>
  );
}

export function CommissionRules() {
  useLensLock(true);
  const { can } = useAuth(); const write = can("commission:write", null); const [form, setForm] = useState<Set | "new" | null>(null); const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["commission-rules"], queryFn: () => api<Set[]>("/commission/rules") });
  return (<>
    <PageHeader title="Commission rules" sub="Who earns what on a sale. The narrowest rule wins: product, brand, category, location, then everything else." actions={write && <Button variant="primary" onClick={() => setForm("new")}>New rule</Button>} />
    {form && <Form key={form === "new" ? "new" : form.id} initial={form === "new" ? undefined : form} onDone={() => setForm(null)} />}
    <div className="grid2" style={{ alignItems: "start" }}>
      <Panel flush>{q.isLoading ? <Skeleton rows={4} /> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : q.data!.length === 0 ? <Empty title="No rules yet">Without a rule nobody earns commission. Start with a rule for everything else.</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="rules-table"><thead><tr><th>Applies to</th><th>Now</th><th>Split</th><th /></tr></thead><tbody>
          {q.data!.map((s) => { const cur = s.versions.find((v) => v.id === s.inForceId); const next = s.versions.find((v) => !cur || v.version > cur.version);
            return [<tr key={s.id}><td><b>{s.label}</b><br /><span className="muted" style={{ fontSize: 12 }}>{SCOPES.find((x) => x.value === s.scopeKind)?.label}</span></td>
              <td>{cur ? (cur.enabled ? <><b>{pct(cur.rateBp)}</b> <span className="muted">{BASIS[cur.basis]}</span></> : <Chip tone="warn">Pays nothing</Chip>) : <span className="muted">Starts {next?.validFrom}</span>}</td>
              <td>{cur?.enabled ? splitLabel(cur.splitMode) : "—"}</td>
              <td className="n"><Button size="sm" variant="ghost" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>History ({s.versions.length})</Button>{write && <Button size="sm" variant="ghost" onClick={() => setForm(s)}>New version</Button>}</td></tr>,
              open === s.id && <tr key={s.id + "h"}><td colSpan={4}><ul className="plain" style={{ margin: 0, paddingLeft: 16 }}>{s.versions.map((v) => <li key={v.id}>Version {v.version} from <b>{v.validFrom}</b>: {v.enabled ? `${pct(v.rateBp)} ${BASIS[v.basis]}, ${splitLabel(v.splitMode).toLowerCase()}` : "pays nothing"}{v.id === s.inForceId ? " (in force today)" : ""}</li>)}</ul></td></tr>];
          })}</tbody></table></div>}</Panel>
      <Preview />
    </div>
  </>);
}
