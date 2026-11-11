export type ColumnKind = "text" | "int" | "money";
export interface ColumnDef { key: string; label: string; kind: ColumnKind; /** Shown in the grant form as sensitive and hidden by default. */ sensitive?: boolean }
export interface ReportDef { key: string; title: string; description: string; columns: ColumnDef[]; groupBys: string[]; defaultGroupBy: string | null }

export const REPORTS: ReportDef[] = [
  { key: "sales", title: "Sales", description: "Orders, takings, refunds and tax by day, location or product. Refunds are matched to the sale they came from.",
    groupBys: ["day", "location", "product"], defaultGroupBy: "day",
    columns: [{ key: "label", label: "", kind: "text" }, { key: "orders", label: "Orders", kind: "int" }, { key: "items", label: "Items", kind: "int" }, { key: "grossMinor", label: "Gross", kind: "money" }, { key: "discountMinor", label: "Discounts", kind: "money" },
      { key: "refundsMinor", label: "Refunds", kind: "money" }, { key: "netMinor", label: "Net", kind: "money" }, { key: "taxMinor", label: "GST included", kind: "money" },
      { key: "costMinor", label: "Cost of goods", kind: "money", sensitive: true }, { key: "marginMinor", label: "Margin", kind: "money", sensitive: true }] },
  { key: "cash_variance", title: "Cash variance", description: "Each closed register session: what the drawer should have held, what was counted, and the difference.",
    groupBys: [], defaultGroupBy: null,
    columns: [{ key: "date", label: "Day", kind: "text" }, { key: "location", label: "Location", kind: "text" }, { key: "register", label: "Register", kind: "text" }, { key: "expectedMinor", label: "Expected", kind: "money" }, { key: "countedMinor", label: "Counted", kind: "money" }, { key: "varianceMinor", label: "Variance", kind: "money" }] },
];
export const REPORT_KEYS = REPORTS.map((r) => r.key);
export const reportDef = (key: string) => REPORTS.find((r) => r.key === key) ?? null;

/** A column that can be worked out from a hidden one is hidden with it: margin gives cost away, so hiding cost hides margin too. */
export const COLUMN_DEPS: Record<string, string[]> = { marginMinor: ["costMinor"] };
/** Everything that must go when `hidden` is hidden, including what would reveal it. */
export function closeHidden(hidden: Iterable<string>): Set<string> {
  const out = new Set(hidden); let changed = true;
  while (changed) { changed = false; for (const [col, deps] of Object.entries(COLUMN_DEPS)) if (!out.has(col) && deps.some((d) => out.has(d))) { out.add(col); changed = true; } }
  return out;
}
export const allColumnKeys = () => [...new Set(REPORTS.flatMap((r) => r.columns.map((c) => c.key)))];
