import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { todayYmd } from "../lib/format";

export interface RailLocation { id: string; code: string; name: string; type: string; timezone: string; today: string; registersOpen: number; devicesOffline: number; openExceptions: number; netTodayMinor: number }
interface Ctx { lens: string; setLens(id: string): void; locations: RailLocation[]; locked: boolean; setLocked(v: boolean): void; selected: RailLocation | null }
const LensContext = createContext<Ctx | null>(null);
export const useLens = () => { const c = useContext(LensContext); if (!c) throw new Error("LensProvider missing"); return c; };
const KEY = "shelfline.admin.lens";

export function LensProvider({ children }: { children: ReactNode }) {
  const [lens, setLensState] = useState<string>(() => { try { return localStorage.getItem(KEY) ?? "all"; } catch { return "all"; } });
  const [locked, setLocked] = useState(false);
  const { data } = useQuery({ queryKey: ["locations-status"], queryFn: () => api<RailLocation[]>("/overview/locations"), refetchInterval: 60_000 });
  const locations = data ?? [];
  // A lens that points at a location this person cannot see (or that was deactivated) falls back to "all".
  const effective = lens === "all" || locations.length === 0 || locations.some((l) => l.id === lens) ? lens : "all";
  const setLens = (id: string) => { setLensState(id); try { localStorage.setItem(KEY, id); } catch { /* ignore */ } };
  useEffect(() => { if (effective !== lens) setLensState(effective); }, [effective, lens]);
  const value: Ctx = { lens: locked ? "all" : effective, setLens, locations, locked, setLocked, selected: locations.find((l) => l.id === effective) ?? null };
  return <LensContext.Provider value={value}>{children}</LensContext.Provider>;
}
/** Pages that are not about one place (catalogue, staff, customers) lock the lens to "all" while they are open. */
export function useLensLock(locked: boolean) { const { setLocked } = useLens(); useEffect(() => { setLocked(locked); return () => setLocked(false); }, [locked, setLocked]); }
/** The location id to send to the API ("" = all). */
export const useLensId = () => { const { lens } = useLens(); return lens === "all" ? undefined : lens; };

/** "Today" in the store's own time zone and business-day cutoff (not the browser's): a sale at 00:30 in Melbourne belongs to Melbourne's date. */
export const useBusinessToday = () => { const { selected, locations } = useLens(); return selected?.today ?? locations.find((l) => l.type === "store")?.today ?? locations[0]?.today ?? todayYmd(); };

/** Time zone of a location, by id or name, so times are shown as the store's clock said, not the viewer's. */
export const useTz = () => { const { locations } = useLens(); return (key?: string | null) => (key ? locations.find((l) => l.id === key || l.name === key)?.timezone : undefined); };
