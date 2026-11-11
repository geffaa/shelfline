import { ForbiddenException } from "@nestjs/common";
import { closeHidden, reportDef, type ColumnDef } from "./catalog";

export interface GrantFacts {
  id: string; reportKeys: string[]; locationIds: string[] | null; rangeKind: "fixed" | "rolling"; rangeFrom: string | null; rangeTo: string | null; rollingDays: number | null;
  hiddenColumns: string[]; expiresAt: Date | null; revokedAt: Date | null;
}
export type EndedReason = "revoked" | "expired";
const ymd = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

export function endedReason(g: Pick<GrantFacts, "expiresAt" | "revokedAt">, now: Date): EndedReason | null {
  if (g.revokedAt) return "revoked"; if (g.expiresAt && g.expiresAt.getTime() <= now.getTime()) return "expired"; return null;
}
/** The dates a grant covers today. A rolling window is worked out at the moment of the request, ending on `today`. */
export function windowOf(g: Pick<GrantFacts, "rangeKind" | "rangeFrom" | "rangeTo" | "rollingDays">, today: string): { from: string; to: string } {
  return g.rangeKind === "fixed" ? { from: g.rangeFrom!, to: g.rangeTo! } : { from: addDays(today, -(g.rollingDays! - 1)), to: today };
}

export interface Request { locationId?: string | null; from?: string | null; to?: string | null }
export interface Served { locationIds: string[] | null; from: string; to: string; empty: boolean; clamped: boolean }

/**
 * Everything a report is allowed to look at, built on the server from one grant. A report query never receives a place or a date from the caller
 * except through `clamp()`: a place outside the grant is refused, dates are cut to the window, and columns the grant hides are removed from the result.
 */
export class ReportScope {
  readonly hidden: Set<string>;
  private constructor(readonly grantId: string | null, private locations: string[] | null, private win: { from: string; to: string }, hidden: Iterable<string>) { this.hidden = closeHidden(hidden); }

  static fromGrant(g: GrantFacts, reportKey: string, today: string, now: Date): ReportScope {
    if (endedReason(g, now)) throw new ForbiddenException({ code: "access_ended" });
    if (!g.reportKeys.includes(reportKey) || !reportDef(reportKey)) throw new ForbiddenException({ code: "report_not_granted" });
    return new ReportScope(g.id, g.locationIds, windowOf(g, today), g.hiddenColumns);
  }
  /** For staff, whose reach comes from their roles rather than a grant: the places their role allows, any dates, and cost hidden unless they may see costs. */
  static forStaff(locations: string[] | null, canSeeCost: boolean): ReportScope {
    return new ReportScope(null, locations, { from: "0001-01-01", to: "9999-12-31" }, canSeeCost ? [] : ["costMinor"]);
  }

  get window() { return this.win; }
  get allowedLocations() { return this.locations; }

  clamp(r: Request): Served {
    let locationIds = this.locations;
    if (r.locationId) { if (this.locations && !this.locations.includes(r.locationId)) throw new ForbiddenException({ code: "outside_grant", what: "location" }); locationIds = [r.locationId]; }
    if (r.from && !ymd.test(r.from) || r.to && !ymd.test(r.to)) throw new ForbiddenException({ code: "bad_date" });
    const from = r.from && r.from > this.win.from ? r.from : this.win.from, to = r.to && r.to < this.win.to ? r.to : this.win.to;
    const clamped = (!!r.from && r.from < this.win.from) || (!!r.to && r.to > this.win.to);
    return { locationIds, from, to, empty: from > to || (locationIds !== null && locationIds.length === 0), clamped };
  }
  columns(cols: ColumnDef[]): ColumnDef[] { return cols.filter((c) => !this.hidden.has(c.key)); }
  /** Rows with hidden columns taken out, so a hidden value can never reach a response, a CSV or a log. */
  strip<T extends Record<string, unknown>>(rows: T[]): Partial<T>[] { return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !this.hidden.has(k))) as Partial<T>); }
  /** A column the caller may sort by: one that is hidden would leak its order. */
  sortable(col: string, fallback: string) { return this.hidden.has(col) ? fallback : col; }
}
