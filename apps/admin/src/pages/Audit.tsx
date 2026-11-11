import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Chip, DatePicker, Select } from "@shelfline/ui";
import { api, qs } from "../lib/api";
import { dateTime, todayYmd, addDays } from "../lib/format";
import { Empty, ErrorBox, PageHeader, Panel, Skeleton } from "../ui";

const ACTIONS = ["", "auth.login", "auth.login_failed", "auth.pin_failed", "authz.denied", "location.create", "location.update", "register.create", "device.create", "device.revoke", "user.create", "user.assignments", "user.pin_set", "user.disable", "product.create", "product.update", "variant.price_change", "variant.update", "catalog.import", "inventory.receive", "inventory.adjust", "customer.create", "customer.update", "session.review", "sale.approval_granted", "sync.exception_resolved"];
const SUBJECTS = ["", "location", "register", "device", "user", "product", "variant", "customer", "register_session", "sync_exception"];

export function Audit() {
  const [action, setAction] = useState(""); const [subject, setSubject] = useState(""); const [from, setFrom] = useState(addDays(todayYmd(), -29)); const [to, setTo] = useState(todayYmd()); const [open, setOpen] = useState<number | null>(null);
  const q = useInfiniteQuery({ queryKey: ["audit", action, subject, from, to], initialPageParam: undefined as number | undefined, queryFn: ({ pageParam }) => api<any[]>(`/audit${qs({ action, subjectType: subject, from, to, beforeId: pageParam, limit: 50 })}`), getNextPageParam: (p) => (p.length === 50 ? p[p.length - 1].id : undefined) });
  const rows = q.data?.pages.flat() ?? [];
  return (<>
    <PageHeader title="Audit log" sub="Who did what, and what changed. Entries cannot be edited or deleted." />
    <div className="filters">
      <Select label="Action" value={action} onChange={setAction} options={ACTIONS.map((a) => ({ value: a, label: a || "Any action" }))} chevron={<ChevronDown size={16} />} />
      <Select label="Subject" value={subject} onChange={setSubject} options={SUBJECTS.map((a) => ({ value: a, label: a ? a.replace(/_/g, " ") : "Any subject" }))} chevron={<ChevronDown size={16} />} />
      <DatePicker label="From" value={from} onChange={(v) => { setFrom(v); if (v > to) setTo(v); }} today={todayYmd()} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />
      <DatePicker label="To" value={to} onChange={(v) => { setTo(v); if (v < from) setFrom(v); }} today={todayYmd()} icon={<Calendar size={16} />} prevIcon={<ChevronLeft size={16} />} nextIcon={<ChevronRight size={16} />} />
    </div>
    <Panel flush>{q.isLoading ? <Skeleton rows={6} /> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : rows.length === 0 ? <Empty title="No entries match">Widen the dates or clear a filter.</Empty> : <>
      <div className="tbl-wrap"><table className="tbl" data-testid="audit-table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Subject</th><th>From</th><th /></tr></thead><tbody>{rows.map((r) => (<>
        <tr key={r.id} className="clickable" tabIndex={0} aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(open === r.id ? null : r.id); }}>
          <td className="mono" style={{ fontSize: 12.5 }}>{dateTime(r.at)}</td><td>{r.actorName ?? <span className="muted">{r.actorKind}</span>}</td><td><Chip tone={r.action.startsWith("authz") || r.action.includes("failed") ? "warn" : undefined}>{r.action}</Chip></td><td>{r.subjectType ?? "—"}</td><td className="mono muted" style={{ fontSize: 12 }}>{r.ip ?? "—"}</td><td className="muted">{(r.before || r.after || r.detail) ? (open === r.id ? "Hide" : "Details") : ""}</td></tr>
        {open === r.id && <tr key={`${r.id}-d`}><td colSpan={6} style={{ background: "var(--surface-2)" }}><div className="diff">{r.before !== null && <div><b>Before</b><pre>{JSON.stringify(r.before, null, 2)}</pre></div>}{r.after !== null && <div><b>After</b><pre>{JSON.stringify(r.after, null, 2)}</pre></div>}{r.detail && <div><b>Detail</b><pre>{JSON.stringify(r.detail, null, 2)}</pre></div>}</div></td></tr>}</>))}</tbody></table></div>
      {q.hasNextPage && <div className="pb"><Button onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>Load more</Button></div>}</>}</Panel>
  </>);
}
