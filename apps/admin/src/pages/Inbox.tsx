import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Chip } from "@shelfline/ui";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { useLensLock } from "../state/lens";
import { Empty, ErrorBox, PageHeader, Panel, Skeleton } from "../ui";

interface Item { id: string; kind: string; title: string; body: string; severity: "info" | "warning" | "critical"; location: string | null; createdAt: string; readAt: string | null }
const TONE = { info: undefined, warning: "warn", critical: "danger" } as const;

/** The messages the notification rules sent to you. Unread ones are bold. */
export function Inbox() {
  useLensLock(true); const qc = useQueryClient();
  const q = useQuery({ queryKey: ["notifications", "list"], refetchInterval: 20_000, queryFn: () => api<Item[]>("/notifications?limit=100") });
  const done = () => { void qc.invalidateQueries({ queryKey: ["notifications"] }); };
  const read = useMutation({ mutationFn: (b: { ids?: string[]; all?: boolean }) => api("/notifications/read", { method: "POST", body: b }), onSuccess: done });
  const unread = (q.data ?? []).filter((n) => !n.readAt).length;
  return (<>
    <PageHeader title="Inbox" sub={unread ? `${unread} unread` : "Everything you were told about, newest first"} actions={<Button disabled={!unread || read.isPending} onClick={() => read.mutate({ all: true })}>Mark all as read</Button>} />
    <Panel flush>{q.isLoading ? <Skeleton rows={5} /> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : q.data!.length === 0 ? <Empty title="Nothing yet">When something happens that one of your notification rules covers, it appears here.</Empty> :
      <ul className="inbox" data-testid="inbox" style={{ listStyle: "none", margin: 0, padding: 0 }}>{q.data!.map((n) => (
        <li key={n.id} className={n.readAt ? "" : "unread"} data-testid="inbox-item" style={{ display: "grid", gap: 4, padding: "14px 18px", borderBottom: "1px solid var(--line)", background: n.readAt ? "transparent" : "var(--volt-soft)" }}>
          <div className="row-flex"><b style={{ fontWeight: n.readAt ? 600 : 800 }}>{n.title}</b>{n.severity !== "info" && <Chip tone={TONE[n.severity]}>{n.severity === "critical" ? "Needs attention" : "Check"}</Chip>}<span className="grow" /><span className="muted" style={{ fontSize: 12.5 }}>{n.location ? `${n.location} · ` : ""}{ago(n.createdAt)}</span>
            {!n.readAt && <Button size="sm" variant="ghost" onClick={() => read.mutate({ ids: [n.id] })}>Mark read</Button>}</div>
          <span style={{ color: "var(--ink-2)" }}>{n.body}</span></li>))}</ul>}</Panel>
  </>);
}
