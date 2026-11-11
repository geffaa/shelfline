import { Chip } from "@shelfline/ui";
import { api, range, day } from "../lib/api";
import { useFetch } from "../lib/use";
import { Empty, Skeleton } from "../ui";

export interface PortalGrant { id: string; status: "active" | "revoked" | "expired"; endedReason: string | null; grantedBy: string; reports: { key: string; title: string }[]; locations: string[] | null; locationOptions: { id: string; name: string }[]; window: { from: string; to: string }; rangeKind: "fixed" | "rolling"; hiddenColumns: string[]; expiresAt: string | null }
export const hiddenText = (cols: string[]) => (cols.length ? `${cols.some((c) => /cost|margin/i.test(c)) ? "cost columns" : "some columns"} hidden` : "");

/** S61: what this person was given. Ended access stays listed, dimmed, so the screen can say who gave it. */
export function MyReports() {
  const q = useFetch(() => api<PortalGrant[]>("/portal/grants"), []);
  return (<>
    <div><h1>My reports</h1><div className="sub">The reports you have been given access to, and exactly what each one covers.</div></div>
    {q.loading ? <Skeleton rows={3} /> : q.error ? <div className="callout danger" role="alert"><div>Could not load your reports.</div></div> : q.data!.length === 0 ? <Empty title="Nothing here yet">When someone gives you access to a report it will be listed here.</Empty> :
      <div className="grants" data-testid="grants">{q.data!.map((g) => (
        <section key={g.id} className={`gcard${g.status === "active" ? "" : " ended"}`} aria-label={g.reports.map((r) => r.title).join(", ")} data-testid="grant">
          <div className="row-flex"><b style={{ fontSize: 17 }}>{g.reports.map((r) => r.title).join(" · ")}</b>{g.status !== "active" && <Chip tone="warn">Access ended</Chip>}</div>
          <div className="gscope"><span><b>{g.locations ? g.locations.join(", ") : "All locations"}</b></span><span>{g.rangeKind === "rolling" ? `Last ${Math.round((Date.parse(g.window.to) - Date.parse(g.window.from)) / 86_400_000) + 1} days, up to ${day(g.window.to)}` : range(g.window.from, g.window.to)}</span>
            {g.hiddenColumns.length > 0 && <span>{hiddenText(g.hiddenColumns)}</span>}{g.expiresAt && g.status === "active" && <span>Access ends {day(g.expiresAt.slice(0, 10))}</span>}
            {g.status !== "active" && <span>Given by {g.grantedBy}. {g.endedReason === "expired" ? "It has expired." : "It was withdrawn."}</span>}</div>
          {g.status === "active" && <div className="gactions">{g.reports.map((r) => <a key={r.key} className="btn primary" href={`#/g/${g.id}/${r.key}`}>Open {r.title}</a>)}</div>}
        </section>))}</div>}
  </>);
}
