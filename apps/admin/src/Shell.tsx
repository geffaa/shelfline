import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, Bell, Inbox as InboxIcon, Megaphone, Boxes, ChevronDown, LayoutDashboard, LogOut, MapPin, Search, Settings, ShoppingBag, Store, Users, X } from "lucide-react";
import { DOMAINS, href, navigate, useRoute } from "./router";
import { api } from "./lib/api";
import { startLive, type LiveState } from "./lib/live";
import { useAuth } from "./state/auth";
import { useLens, type RailLocation } from "./state/lens";

const ICONS: Record<string, ReactNode> = { "layout-dashboard": <LayoutDashboard size={18} />, "shopping-bag": <ShoppingBag size={18} />, boxes: <Boxes size={18} />, users: <Users size={18} />, banknote: <Banknote size={18} />, settings: <Settings size={18} />, megaphone: <Megaphone size={18} /> };
const tzAbbr = (tz: string) => new Intl.DateTimeFormat("en-AU", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";
const railStatus = (l: RailLocation) => l.type === "warehouse" ? "Warehouse" : l.registersOpen > 0 ? `Open · ${l.registersOpen} register${l.registersOpen === 1 ? "" : "s"}` : "Closed";
const dotClass = (l: RailLocation) => (l.type === "warehouse" || l.registersOpen > 0 ? "ok" : "off");

export function useVisibleDomains() {
  const { canAny } = useAuth();
  return DOMAINS.map((d) => ({ ...d, pages: d.pages.filter((p) => canAny(("perm" in p && p.perm) || d.perm)) })).filter((d) => d.pages.length > 0);
}

function LocationList({ onPick, compact }: { onPick?: () => void; compact?: boolean }) {
  const { lens, setLens, locations, locked } = useLens();
  const total = locations.reduce((a, l) => a + l.netTodayMinor, 0); void total;
  const pick = (id: string) => { if (locked) return; setLens(id); onPick?.(); };
  return (<>
    {!compact && <h2>Locations</h2>}
    <button type="button" className="loc all" aria-current={lens === "all" ? "true" : undefined} onClick={() => pick("all")} disabled={locked && lens !== "all"} data-testid="lens-all"><span className="dot-s" /><span className="nm">All locations</span><span className="tz" /><span className="st">{locations.length} location{locations.length === 1 ? "" : "s"}{locations.filter((l) => l.registersOpen > 0).length ? ` · ${locations.filter((l) => l.registersOpen > 0).length} open` : ""}</span></button>
    {locations.map((l) => (
      <button type="button" key={l.id} className="loc" aria-current={lens === l.id ? "true" : undefined} onClick={() => pick(l.id)} aria-disabled={locked || undefined} title={locked ? "This page covers all locations" : undefined} data-testid={`lens-${l.code}`}>
        <span className={`dot-s ${dotClass(l)}`} /><span className="nm">{l.name}</span><span className="tz">{tzAbbr(l.timezone)}</span>
        <span className="st">{railStatus(l)}</span>{l.devicesOffline > 0 ? <span className="badge">{l.devicesOffline} offline</span> : l.openExceptions > 0 ? <span className="badge">{l.openExceptions} to review</span> : null}
      </button>))}
  </>);
}

function Menu({ children, label, button }: { children: ReactNode; label: string; button: ReactNode }) {
  const [open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) return; const off = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); }; document.addEventListener("pointerdown", off); document.addEventListener("keydown", esc); return () => { document.removeEventListener("pointerdown", off); document.removeEventListener("keydown", esc); }; }, [open]);
  return <div ref={ref} style={{ position: "relative" }}><button type="button" className="btn ghost" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{button}</button>{open && <div className="menu" role="menu" onClick={() => setOpen(false)}>{children}</div>}</div>;
}

export function Shell({ children }: { children: ReactNode }) {
  const { me, logout } = useAuth(); const route = useRoute(); const { locations, selected, lens } = useLens(); const domains = useVisibleDomains(); const qc = useQueryClient();
  const [live, setLive] = useState<LiveState>("connecting"); const [sheet, setSheet] = useState(false); const [q, setQ] = useState("");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null; const pending = new Set<string>();
    const flush = () => { timer = null; const keys = [...pending]; pending.clear(); for (const k of keys) void qc.invalidateQueries({ queryKey: [k] }); };
    const stop = startLive((e) => {
      const keys = e.kind === "notification" ? ["notifications"] : e.kind === "exception" ? ["exceptions", "overview", "locations-status", "orders"] : ["overview", "orders", "sessions", "session", "locations-status", "reports", "exceptions", "order", "customers"];
      keys.forEach((k) => pending.add(k)); if (!timer) timer = setTimeout(flush, 250);   // one refetch per burst of events
    }, setLive);
    return () => { stop(); if (timer) clearTimeout(timer); };
  }, [qc]);
  const exceptions = locations.reduce((a, l) => a + l.openExceptions, 0);
  const unreadQ = useQuery({ queryKey: ["notifications", "unread"], refetchInterval: 20_000, queryFn: () => api<{ count: number }>("/notifications/unread-count") }); const unread = unreadQ.data?.count ?? 0;
  const dom = domains.find((d) => d.key === route.domain) ?? domains[0]; const pageLabel = dom?.pages.find((p) => p.key === route.page)?.label;
  const role = useMemo(() => me?.assignments.map((a) => a.role.replace(/_/g, " ")).filter((v, i, a) => a.indexOf(v) === i).join(", ") ?? "", [me]);
  const initials = (me?.user.name ?? "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const hidden = DOMAINS.find((d) => d.key === "admin");
  return (
    <div className="adm">
      <header className="top">
        <div className="brand"><span className="mk"><Store size={16} /></span>Shelfline</div>
        <nav className="domains" aria-label="Domains">{domains.filter((d) => !("hidden" in d && d.hidden)).map((d) => <a key={d.key} href={href(d.key, d.pages[0]!.key)} aria-current={route.domain === d.key ? "page" : undefined}>{ICONS[d.icon]}<span>{d.label}</span></a>)}</nav>
        <div className="tools">
          <span className="livechip" role="status" data-testid="live-chip"><span className={`dot-s ${live === "live" ? "ok" : live === "connecting" ? "warn" : "off"}`} />{live === "live" ? "Live" : live === "connecting" ? "Connecting" : "Reconnecting"}</span>
          <form className="input" style={{ minWidth: 220 }} onSubmit={(e) => { e.preventDefault(); navigate("sell", "orders", undefined, q ? { q } : undefined); }} role="search"><Search size={16} /><input aria-label="Search orders by receipt number or customer" placeholder="Search receipts or customers" value={q} onChange={(e) => setQ(e.target.value)} /></form>
          <a className="btn ghost bell" href={href("today", "inbox")} aria-label={`Inbox: ${unread} unread`} data-testid="inbox-link"><InboxIcon size={18} />{unread > 0 && <span className="cnt">{unread}</span>}</a>
          <a className="btn ghost bell" href={href("today", "alerts")} aria-label={`Alerts: ${exceptions} to review`}><Bell size={18} />{exceptions > 0 && <span className="cnt">{exceptions}</span>}</a>
          {hidden && <a className="btn ghost gear" href={href("admin", hidden.pages[0]!.key)} aria-label="Admin settings" aria-current={route.domain === "admin" ? "page" : undefined}><Settings size={18} /></a>}
          <Menu label="Account menu" button={<span className="avatar">{initials}</span>}><div className="who"><b>{me?.user.name}</b><br /><span className="muted" style={{ fontSize: 13 }}>{me?.user.email} · {role}</span></div>{hidden && <a role="menuitem" className="only-mobile" href={href("admin", hidden.pages[0]!.key)}><Settings size={16} />Admin settings</a>}<button role="menuitem" onClick={logout}><LogOut size={16} />Sign out</button></Menu>
        </div>
      </header>
      <div className="body">
        <aside className="rail" aria-label="Locations"><LocationList /></aside>
        <main className="main">
          <button type="button" className="lochip" onClick={() => setSheet(true)} aria-label="Choose location"><MapPin size={16} />{lens === "all" || !selected ? "All locations" : selected.name}<ChevronDown size={16} /></button>
          {dom && dom.pages.length > 1 && <nav className="subnav" aria-label={`${dom.label} pages`}>{dom.pages.map((p) => <a key={p.key} href={href(dom.key, p.key)} aria-current={route.page === p.key ? "page" : undefined}>{p.label}</a>)}</nav>}
          {children}
          <span className="sr" aria-live="polite">{pageLabel}</span>
        </main>
      </div>
      <nav className="mtabs" aria-label="Domains">{domains.filter((d) => !("hidden" in d && d.hidden)).map((d) => <a key={d.key} href={href(d.key, d.pages[0]!.key)} aria-current={route.domain === d.key ? "page" : undefined}>{ICONS[d.icon]}<span>{d.label}</span></a>)}</nav>
      {sheet && <div className="sheet-bg" onClick={() => setSheet(false)}><div className="sheet-card rail" role="dialog" aria-label="Choose location" style={{ background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}><div className="row-flex" style={{ justifyContent: "space-between" }}><b>Location</b><button className="btn ghost sm" aria-label="Close" onClick={() => setSheet(false)}><X size={16} /></button></div><LocationList compact onPick={() => setSheet(false)} /></div></div>}
    </div>
  );
}
