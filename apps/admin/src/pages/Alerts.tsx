import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Button, Chip, Segmented } from "@shelfline/ui";
import { api, qs } from "../lib/api";
import { ago, flagLabel } from "../lib/format";
import { href } from "../router";
import { useAuth } from "../state/auth";
import { useLensId } from "../state/lens";
import { Empty, ErrorBox, PageHeader, Panel, Skeleton } from "../ui";

interface Exc { id: string; kind: string; refType: string | null; refId: string | null; receiptNo: string | null; detail: any; status: string; createdAt: string; resolvedAt: string | null; device: string; locationId: string; location: string }
const HELP: Record<string, string> = {
  price_book_mismatch: "The till priced an item from a price book that has since changed (or one it did not have). The customer paid the till's price; the sale stands.", promo_mismatch: "The till's promotion discount differed from the server's. The sale stands.", gift_card_overdraft: "A gift card or store credit was spent beyond its balance (two tills at once, or an offline sale). The sale stands and the account is now negative: top it up, or take the difference from the customer.", gift_card_unknown: "A gift card payment used a code the system does not know. Check the sale and the card.", gift_card_void: "A cancelled gift card was used.", gift_card_expired: "An expired gift card was used.", store_credit_no_customer: "Store credit was used on a sale with no customer, so nothing could be deducted.", refund_credit_no_customer: "A refund to store credit was recorded on a sale with no customer, so no credit was added.",
  negative_stock: "A sale left less stock than the ledger had. Recount the item, or adjust stock; the sale stands.", price_mismatch: "The till's total differed from the server's. The customer paid the till's total.", payment_mismatch: "Payments did not add up to the total.",
  discount_unapproved: "A discount above the cashier's limit arrived without a manager's approval.", late_sale: "A sale arrived after its register was closed.", variance_over_limit: "The counted cash differs from the expected cash by more than the limit.", over_refund: "More units were refunded than were sold (two tills refunded the same item).",
  refund_unapproved: "A large refund arrived without a manager's approval.", no_sale_no_reason: "The drawer was opened without a sale and no reason was given.", skewed_clock: "The till's clock is more than five minutes off; the server's time was used.",
};
const summary = (d: any) => { if (!d || typeof d !== "object") return ""; const x = d.server && d.client ? `till ${d.client.totalMinor / 100} vs server ${d.server.totalMinor / 100}` : d.varianceMinor !== undefined ? `variance ${d.varianceMinor / 100}` : d.lines ? d.lines.map((l: any) => `${l.onHand} on hand`).join(", ") : ""; return x; };

export function Alerts() {
  const { can } = useAuth(); const lensId = useLensId(); const qc = useQueryClient(); const [status, setStatus] = useState<"open" | "resolved">("open");
  const q = useQuery({ queryKey: ["exceptions", lensId ?? "all", status], queryFn: () => api<Exc[]>(`/exceptions${qs({ locationId: lensId, status })}`) });
  const resolve = useMutation({ mutationFn: (id: string) => api(`/exceptions/${id}/resolve`, { method: "POST" }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["exceptions"] }); void qc.invalidateQueries({ queryKey: ["locations-status"] }); void qc.invalidateQueries({ queryKey: ["overview"] }); } });
  return (<>
    <PageHeader title="Alerts" sub="Things the tills recorded that a person should look at. The sale or cash entry stands; nothing is undone." actions={<Segmented label="Show" value={status} onChange={setStatus} options={[{ value: "open", label: "Open" }, { value: "resolved", label: "Resolved" }]} />} />
    <Panel flush>
      {q.isLoading ? <Skeleton rows={4} /> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : q.data!.length === 0 ? <Empty title={status === "open" ? "Nothing to review" : "Nothing resolved yet"}>{status === "open" ? "When a till records something unusual, it will show here." : "Resolved alerts are kept here."}</Empty> :
        <div className="tbl-wrap"><table className="tbl" data-testid="alerts-table"><thead><tr><th>What</th><th>Where</th><th>Detail</th><th>When</th><th /></tr></thead><tbody>{q.data!.map((e) => (
          <tr key={e.id}><td><Chip tone="warn">{flagLabel(e.kind)}</Chip><div className="muted" style={{ whiteSpace: "normal", maxWidth: 360, marginTop: 4 }}>{HELP[e.kind] ?? ""}</div></td>
            <td>{e.location}<br /><span className="muted">{e.device}</span></td>
            <td>{e.refType === "sale" && e.refId ? <a href={href("sell", "orders", e.refId)}>Receipt {e.receiptNo}</a> : e.refType === "register_session" && e.refId ? <a href={href("today", "sessions", e.refId)}>Register session</a> : <span className="muted">{e.refType ?? ""}</span>}<div className="muted">{summary(e.detail)}</div></td>
            <td className="muted">{ago(e.createdAt)}</td>
            <td className="right">{status === "open" && can("cash:approve", e.locationId) && <Button size="sm" onClick={() => resolve.mutate(e.id)} disabled={resolve.isPending}><Check size={14} />Resolve</Button>}</td></tr>))}</tbody></table></div>}
    </Panel>
  </>);
}
