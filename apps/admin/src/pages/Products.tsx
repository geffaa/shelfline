import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Plus, Search, Trash2, Upload, X } from "lucide-react";
import { Button, Chip, DropZone, Segmented, Select } from "@shelfline/ui";
import { api, ApiError, qs } from "../lib/api";
import { money } from "../lib/format";
import { navigate, useRoute } from "../router";
import { useAuth } from "../state/auth";
import { useLensLock } from "../state/lens";
import { Empty, ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface P { id: string; title: string; brand: string | null; status: string; variantCount: number; priceMinMinor: number | null; priceMaxMinor: number | null }
const cents = (s: string): number | null => { const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s.trim()); return m ? Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0") : null; };
const range = (p: P) => p.priceMinMinor === null ? "—" : p.priceMinMinor === p.priceMaxMinor ? money(p.priceMinMinor) : `${money(p.priceMinMinor)} – ${money(p.priceMaxMinor)}`;

function VariantRow({ v, canWrite, onSaved }: { v: any; canWrite: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState(false); const [price, setPrice] = useState((v.basePriceMinor / 100).toFixed(2)); const [barcode, setBarcode] = useState(v.barcode ?? ""); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => { const p = cents(price); if (p === null) throw new Error("price"); return api(`/variants/${v.id}`, { method: "PATCH", body: { basePriceMinor: p, barcode: barcode.trim() || null } }); }, onSuccess: () => { setEdit(false); onSaved(); }, onError: (e) => setErr(e instanceof ApiError && e.status === 409 ? "That barcode is already used." : "Enter a price like 219.95 and a barcode of 6-32 letters or digits.") });
  const archive = useMutation({ mutationFn: () => api(`/variants/${v.id}`, { method: "PATCH", body: { status: v.status === "active" ? "archived" : "active" } }), onSuccess: onSaved });
  return (
    <tr>
      <td><b className="mono">{v.sku}</b><br /><span className="muted">{Object.values(v.options ?? {}).join(" · ")}</span></td>
      <td>{edit ? <div className="input" style={{ minWidth: 150 }}><input aria-label={`Barcode for ${v.sku}`} value={barcode} onChange={(e) => setBarcode(e.target.value)} /></div> : <span className="mono">{v.barcode ?? "—"}</span>}</td>
      <td className="n">{edit ? <div className="input" style={{ width: 110, marginLeft: "auto" }}><input aria-label={`Price for ${v.sku}`} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></div> : money(v.basePriceMinor)}</td>
      <td>{v.status === "archived" ? <Chip>Archived</Chip> : null}</td>
      <td className="right">{canWrite && (edit ? <span className="row-flex" style={{ justifyContent: "flex-end", gap: 6 }}><Button size="sm" onClick={() => { setEdit(false); setErr(null); }}>Cancel</Button><Button size="sm" variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button></span> : <span className="row-flex" style={{ justifyContent: "flex-end", gap: 6 }}><Button size="sm" onClick={() => setEdit(true)}>Edit</Button><Button size="sm" variant="ghost" onClick={() => archive.mutate()}>{v.status === "active" ? "Archive" : "Restore"}</Button></span>)}{err && <div className="err" role="alert" style={{ fontSize: 12.5 }}>{err}</div>}</td>
    </tr>
  );
}

function ProductDetail({ id }: { id: string }) {
  const { canAny } = useAuth(); const qc = useQueryClient(); const canWrite = canAny("catalog:write");
  const q = useQuery({ queryKey: ["product", id], queryFn: () => api<any>(`/products/${id}`) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["product", id] }); void qc.invalidateQueries({ queryKey: ["products"] }); };
  const [sku, setSku] = useState(""); const [price, setPrice] = useState(""); const [adding, setAdding] = useState(false); const [err, setErr] = useState<string | null>(null);
  const add = useMutation({ mutationFn: () => { const p = cents(price); if (p === null) throw new Error("price"); return api(`/products/${id}/variants`, { method: "POST", body: { sku: sku.trim(), basePriceMinor: p } }); }, onSuccess: () => { setAdding(false); setSku(""); setPrice(""); refresh(); }, onError: (e) => setErr(e instanceof ApiError && e.status === 409 ? "That SKU already exists." : "Use a SKU of letters, digits, dots or dashes and a price like 219.95.") });
  const toggle = useMutation({ mutationFn: () => api(`/products/${id}`, { method: "PATCH", body: { status: q.data.status === "active" ? "archived" : "active" } }), onSuccess: refresh });
  if (q.isLoading) return <Panel><Skeleton rows={6} /></Panel>; if (q.isError) return <ErrorBox error={q.error} retry={() => q.refetch()} />; const p = q.data!;
  return (
    <section className="panel detail" aria-label={p.title} style={{ minWidth: 0 }}>
      <div className="drawer-head"><h2>{p.title}</h2><span className="row-flex" style={{ gap: 6 }}>{p.status === "archived" && <Chip>Archived</Chip>}<button className="btn ghost sm" aria-label="Close details" onClick={() => navigate("stock", "products")}><X size={16} /></button></span></div>
      <div className="pb stack">
        <dl className="kv"><dt>Brand</dt><dd>{p.brand ?? "—"}</dd><dt>Variants</dt><dd>{p.variants.length}</dd></dl>
        <div className="tbl-wrap"><table className="tbl" data-testid="variants-table"><thead><tr><th>Variant</th><th>Barcode</th><th className="n">Price</th><th /><th /></tr></thead><tbody>{p.variants.map((v: any) => <VariantRow key={v.id + v.version} v={v} canWrite={canWrite} onSaved={refresh} />)}</tbody></table></div>
        {canWrite && (adding ? <form className="row-flex" onSubmit={(e) => { e.preventDefault(); setErr(null); add.mutate(); }}><div className="input"><input aria-label="New variant SKU" placeholder="SKU" value={sku} onChange={(e) => setSku(e.target.value)} /></div><div className="input" style={{ width: 120 }}><input aria-label="New variant price" placeholder="Price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></div><Button type="submit" variant="primary" disabled={!sku || !price}>Add variant</Button><Button onClick={() => setAdding(false)}>Cancel</Button></form> : <div className="row-flex"><Button onClick={() => setAdding(true)}><Plus size={14} />Add variant</Button><Button variant="ghost" onClick={() => toggle.mutate()}>{p.status === "active" ? "Archive product" : "Restore product"}</Button></div>)}
        {err && <p className="err" role="alert">{err}</p>}
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Price changes are recorded in the audit log with the old and new price. Tills pick them up on their next sync.</p>
      </div>
    </section>
  );
}

function NewProduct({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => api<any[]>("/categories") }); const tax = useQuery({ queryKey: ["tax-classes"], queryFn: () => api<any[]>("/tax-classes") }); const qc = useQueryClient();
  const [title, setTitle] = useState(""); const [brand, setBrand] = useState(""); const [cat, setCat] = useState<string | null>(null); const [taxId, setTaxId] = useState<string | null>(null);
  const [rows, setRows] = useState([{ sku: "", barcode: "", price: "", size: "", colour: "" }]); const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => { if (!taxId) throw new Error("tax"); const variants = rows.map((r) => ({ sku: r.sku.trim(), ...(r.barcode.trim() ? { barcode: r.barcode.trim() } : {}), basePriceMinor: cents(r.price) ?? -1, options: { ...(r.size ? { size: r.size } : {}), ...(r.colour ? { colour: r.colour } : {}) } })); return api("/products", { method: "POST", body: { title: title.trim(), ...(brand.trim() ? { brand: brand.trim() } : {}), ...(cat ? { categoryId: cat } : {}), taxClassId: taxId, variants } }); },
    onSuccess: (p: any) => { void qc.invalidateQueries({ queryKey: ["products"] }); onDone(p.id); },
    onError: (e) => setErr(e instanceof ApiError && e.status === 409 ? `That ${e.code === "barcode_exists" ? "barcode" : "SKU"} already exists${e.body?.sku ? `: ${e.body.sku}` : ""}.` : "Check the title, tax class, SKUs (letters, digits, dots, dashes) and prices (like 219.95)."),
  });
  const set = (i: number, k: string, v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <section className="panel detail" aria-label="New product">
      <div className="drawer-head"><h2>New product</h2><button className="btn ghost sm" aria-label="Cancel" onClick={onCancel}><X size={16} /></button></div>
      <form className="pb stack" onSubmit={(e) => { e.preventDefault(); setErr(null); save.mutate(); }}>
        <Field id="pt" label="Title"><TextInput id="pt" value={title} onChange={setTitle} required autoFocus /></Field>
        <Field id="pb" label="Brand"><TextInput id="pb" value={brand} onChange={setBrand} /></Field>
        <div className="row-flex"><div><div className="lbl" style={{ marginBottom: 4 }}>Category</div><Select label="Category" value={cat} onChange={setCat} options={(cats.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="None" chevron={<ChevronDown size={16} />} /></div>
          <div><div className="lbl" style={{ marginBottom: 4 }}>Tax class</div><Select label="Tax class" value={taxId} onChange={setTaxId} options={(tax.data ?? []).map((c) => ({ value: c.id, label: c.name }))} placeholder="Choose" chevron={<ChevronDown size={16} />} /></div></div>
        <b>Variants</b>
        {rows.map((r, i) => <div key={i} className="stack" style={{ padding: 8, border: "1px solid var(--line)", borderRadius: "var(--r)" }}>
          <div className="row-flex"><div className="input grow"><input aria-label={`SKU ${i + 1}`} placeholder="SKU" value={r.sku} onChange={(e) => set(i, "sku", e.target.value)} /></div><div className="input" style={{ width: 120 }}><input aria-label={`Price ${i + 1}`} placeholder="Price" inputMode="decimal" value={r.price} onChange={(e) => set(i, "price", e.target.value)} /></div>{rows.length > 1 && <Button size="sm" variant="ghost" aria-label={`Remove variant ${i + 1}`} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><Trash2 size={14} /></Button>}</div>
          <div className="row-flex"><div className="input grow"><input aria-label={`Barcode ${i + 1}`} placeholder="Barcode (optional)" value={r.barcode} onChange={(e) => set(i, "barcode", e.target.value)} /></div><div className="input" style={{ width: 90 }}><input aria-label={`Size ${i + 1}`} placeholder="Size" value={r.size} onChange={(e) => set(i, "size", e.target.value)} /></div><div className="input" style={{ width: 120 }}><input aria-label={`Colour ${i + 1}`} placeholder="Colour" value={r.colour} onChange={(e) => set(i, "colour", e.target.value)} /></div></div></div>)}
        <div><Button onClick={() => setRows((r) => [...r, { sku: "", barcode: "", price: "", size: "", colour: "" }])}><Plus size={14} />Add another variant</Button></div>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="row-flex"><Button onClick={onCancel}>Cancel</Button><span className="grow" /><Button variant="primary" type="submit" disabled={!title.trim() || !taxId || rows.some((r) => !r.sku.trim() || cents(r.price) === null) || save.isPending}>Create product</Button></div>
      </form>
    </section>
  );
}

function ImportPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient(); const [file, setFile] = useState<File | null>(null); const [text, setText] = useState(""); const [report, setReport] = useState<any>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const run = async (dry: boolean) => { setBusy(true); setErr(null); try { const r = await api(`/catalog/import${dry ? "?dryRun=true" : ""}`, { method: "POST", body: text }); setReport(r); if (!dry) void qc.invalidateQueries({ queryKey: ["products"] }); } catch (e) { setErr(e instanceof ApiError ? (e.body?.code === "csv_missing_column" ? `The file needs a "${e.body.column}" column.` : e.body?.code === "csv_malformed" ? "The file is not valid CSV (an unclosed quote?)." : e.body?.code === "csv_too_large" ? "More than 20,000 rows: split the file." : "The import was refused.") : "Could not reach the server."); } finally { setBusy(false); } };
  return (
    <section className="panel detail" aria-label="Import products">
      <div className="drawer-head"><h2>Import products from CSV</h2><button className="btn ghost sm" aria-label="Close import" onClick={onClose}><X size={16} /></button></div>
      <div className="pb stack">
        <p className="muted" style={{ margin: 0 }}>Columns: <span className="mono">product_title, brand, category, tax_class, sku, barcode, price, cost, option_size, option_colour</span>. Prices like 219.95. Rows that are fine are imported; rows that are not are listed with their line number.</p>
        <DropZone label={file ? file.name : "Drop a CSV here"} hint="up to 20,000 rows" accept=".csv,text/csv" icon={<Upload size={22} />} onFiles={async (f) => { const x = f[0]; if (!x) return; setFile(x); setText(await x.text()); setReport(null); }} />
        <div className="row-flex"><Button onClick={() => run(true)} disabled={!text || busy}>Check the file</Button><Button variant="primary" onClick={() => run(false)} disabled={!text || busy}>Import</Button></div>
        {err && <p className="err" role="alert">{err}</p>}
        {report && <div className="callout info" role="status" data-testid="import-report"><div><b>{report.dryRun ? "Check complete: " : "Imported: "}</b>{report.imported.variants} variant{report.imported.variants === 1 ? "" : "s"} in {report.imported.products} new product{report.imported.products === 1 ? "" : "s"}; {report.errors.length} row{report.errors.length === 1 ? "" : "s"} with problems out of {report.rows}.</div></div>}
        {report?.errors.length > 0 && <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 240, overflow: "auto", fontSize: 13 }}>{report.errors.slice(0, 50).map((e: any) => <li key={e.line}>Line {e.line}: {e.errors.join("; ")}</li>)}{report.errors.length > 50 && <li>…and {report.errors.length - 50} more</li>}</ul>}
      </div>
    </section>
  );
}

export function Products() {
  useLensLock(true); const route = useRoute(); const { canAny } = useAuth(); const [q, setQ] = useState(""); const [status, setStatus] = useState<"active" | "archived">("active"); const [mode, setMode] = useState<"none" | "new" | "import">("none");
  const list = useQuery({ queryKey: ["products", q, status], queryFn: () => api<{ items: P[]; next: string | null }>(`/products${qs({ q, status, limit: 100 })}`) }); const sel = route.id; const canWrite = canAny("catalog:write");
  return (<>
    <PageHeader title="Products" sub="The catalogue is shared by every location" actions={canWrite ? <><Button onClick={() => setMode("import")}><Upload size={14} />Import CSV</Button><Button variant="primary" onClick={() => setMode("new")}><Plus size={14} />New product</Button></> : undefined} />
    <div className="filters"><label className="input" style={{ minWidth: 280 }}><Search size={16} /><input aria-label="Search products" placeholder="Title, brand, SKU or barcode" value={q} onChange={(e) => setQ(e.target.value)} /></label><Segmented label="Status" value={status} onChange={setStatus} options={[{ value: "active", label: "Active" }, { value: "archived", label: "Archived" }]} /></div>
    <div className={`md${sel || mode !== "none" ? "" : " single"}`}>
      <Panel flush>{list.isLoading ? <Skeleton rows={6} /> : list.isError ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : list.data!.items.length === 0 ? <Empty title="No products found" action={canWrite ? <Button variant="primary" onClick={() => setMode("new")}>Create the first product</Button> : undefined}>Add products one at a time or import a CSV.</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="products-table"><thead><tr><th>Product</th><th>Brand</th><th className="n">Variants</th><th className="n">Price</th></tr></thead><tbody>{list.data!.items.map((p) => <tr key={p.id} className="clickable" tabIndex={0} aria-selected={sel === p.id} onClick={() => { setMode("none"); navigate("stock", "products", p.id); }} onKeyDown={(e) => { if (e.key === "Enter") navigate("stock", "products", p.id); }}><td><b>{p.title}</b></td><td>{p.brand ?? <span className="muted">—</span>}</td><td className="n">{p.variantCount}</td><td className="n">{range(p)}</td></tr>)}</tbody></table></div>}</Panel>
      {mode === "new" ? <NewProduct onCancel={() => setMode("none")} onDone={(id) => { setMode("none"); navigate("stock", "products", id); }} /> : mode === "import" ? <ImportPanel onClose={() => setMode("none")} /> : sel && <ProductDetail id={sel} />}
    </div>
  </>);
}
