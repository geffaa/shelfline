import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SCHEMA_V } from "@shelfline/contracts";
import { AuthError, DexieStore, HttpTransport, SyncEngine, uuidv7, type FlaggedRecord, type LocalStore, type RejectionRecord } from "@shelfline/sync-client";
import { Catalogue } from "../lib/catalogue";
import { signIn as apiSignIn } from "../lib/api";
import { closeRegister } from "../lib/cash";
import { pendingSold, type LocalSession } from "../lib/sales";
import { loadAuth, loadDevice, saveAuth, saveDevice, type AuthState, type DeviceConfig } from "./config";

export type SyncState = "online" | "offline" | "syncing";
export interface SyncInfo { state: SyncState; queued: number; lastSyncAt: string | null; ready: boolean; authExpired: boolean; seqDivergence: boolean; updateRequired: boolean; clockSkewMs?: number | null; error?: string }
interface Ctx {
  store: LocalStore; device: DeviceConfig | null; pair(d: DeviceConfig): void; unpair(): void;
  auth: AuthState | null; signIn(code: string, pin: string): Promise<void>; signOut(): void;
  catalogue: Catalogue | null; reloadCatalogue(): Promise<void>;
  session: LocalSession | null; openSession(floatMinor: number, breakdown: Record<string, number>): Promise<void>;
  closeSession(countedMinor: number, breakdown: Record<string, number>, approvalToken?: string): Promise<void>; clearSession(): Promise<void>;
  sync: SyncInfo; syncNow(): Promise<void>; problems(): Promise<{ rejections: RejectionRecord[]; flagged: FlaggedRecord[] }>;
}
const AppContext = createContext<Ctx | null>(null);
export const useApp = () => { const c = useContext(AppContext); if (!c) throw new Error("AppProvider missing"); return c; };

export function AppProvider({ children, store: injected }: { children: ReactNode; store?: LocalStore }) {
  const store = useMemo<LocalStore>(() => injected ?? new DexieStore("shelfline-pos"), [injected]);
  const [device, setDevice] = useState<DeviceConfig | null>(() => loadDevice());
  const [auth, setAuth] = useState<AuthState | null>(() => loadAuth());
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [session, setSession] = useState<LocalSession | null>(null);
  const [sync, setSync] = useState<SyncInfo>({ state: navigator.onLine ? "online" : "offline", queued: 0, lastSyncAt: null, ready: false, authExpired: false, seqDivergence: false, updateRequired: false });
  const busy = useRef(false); const authRef = useRef(auth); authRef.current = auth;

  const reloadCatalogue = useCallback(async () => { setCatalogue(await Catalogue.load(store, await pendingSold(store), authRef.current?.registerId ?? null)); }, [store]);
  useEffect(() => { void reloadCatalogue(); }, [auth?.registerId, reloadCatalogue]);
  const refreshLocal = useCallback(async () => {
    const [queued, cursor, last] = await Promise.all([store.pendingCount(), store.getMeta("cursor"), store.getMeta("lastSyncAt")]);
    setSync((s) => ({ ...s, queued, ready: !!cursor, lastSyncAt: last ?? s.lastSyncAt }));
    if (cursor) await reloadCatalogue();
  }, [store, reloadCatalogue]);

  const engine = useMemo(() => device && auth ? new SyncEngine(store, new HttpTransport(device.apiUrl, () => authRef.current?.token ?? ""), () => new Date()) : null, [store, device, auth?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  const syncNow = useCallback(async () => {
    if (!engine || busy.current) return; busy.current = true;
    setSync((s) => ({ ...s, state: "syncing" }));
    try {
      await engine.reconcileSequence().catch(() => undefined);
      const ok = await engine.syncOnce();
      if (ok) await store.transact((tx) => tx.setMeta("lastSyncAt", new Date().toISOString()));
      const st = engine.state.serverStatus; const tooOld = !!st && st.minSchemaV > SCHEMA_V;
      const refused = (await store.rejections()).some((r) => r.reason === "update_required" || r.reason === "unsupported_schema");
      setSync((s) => ({ ...s, state: ok ? "online" : "offline", error: engine.state.lastError, authExpired: false, seqDivergence: !!engine.state.seqDivergence, updateRequired: tooOld || refused, clockSkewMs: st?.clockSkewMs ?? s.clockSkewMs }));
    } catch (e) {
      if (e instanceof AuthError) setSync((s) => ({ ...s, state: "online", authExpired: true })); else setSync((s) => ({ ...s, state: "offline", error: String(e) }));
    } finally { busy.current = false; await refreshLocal(); }
  }, [engine, store, refreshLocal]);

  useEffect(() => { void refreshLocal(); void store.get<LocalSession>("session", "current").then((s) => setSession(s ?? null)); }, [store, refreshLocal]);
  useEffect(() => {
    if (!engine) return;
    void syncNow(); const t = setInterval(() => void syncNow(), 15_000);
    const on = () => void syncNow(); const off = () => setSync((s) => ({ ...s, state: "offline" }));
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { clearInterval(t); window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, [engine, syncNow]);

  const value: Ctx = {
    store, device, pair: (d) => { saveDevice(d); void store.transact((tx) => tx.setMeta("freshPair", "1")); setDevice(d); }, unpair: () => { saveDevice(null); saveAuth(null); setDevice(null); setAuth(null); },
    auth, signIn: async (code, pin) => { if (!device) throw new Error("not paired"); const a = await apiSignIn(device.apiUrl, device.deviceKey, code, pin); saveAuth(a); setAuth(a); setSync((s) => ({ ...s, authExpired: false })); },
    signOut: () => { saveAuth(null); setAuth(null); },
    catalogue, reloadCatalogue, session,
    openSession: async (openingFloatMinor, countBreakdown) => {
      if (!auth) throw new Error("not signed in");
      const s: LocalSession = { id: uuidv7(), openedAt: new Date().toISOString(), openingFloatMinor, cashierId: auth.userId, cashierName: auth.name };
      await store.transact(async (tx) => { await tx.put("session", "current", s); await tx.enqueue({ type: "session.open", payload: { sessionId: s.id, openingFloatMinor, countBreakdown }, actorId: auth.userId, schemaV: SCHEMA_V }); });
      setSession(s); await refreshLocal(); void syncNow();
    },
    closeSession: async (countedMinor, breakdown, approvalToken) => {
      if (!auth || !session) throw new Error("no open register");
      setSession(await closeRegister(store, { session, cashierId: auth.userId, countedMinor, breakdown, approvalToken })); await refreshLocal(); void syncNow();
    },
    clearSession: async () => { await store.transact((tx) => tx.del("session", "current")); setSession(null); },
    sync, syncNow, problems: async () => ({ rejections: await store.rejections(), flagged: await store.flagged() }),
  };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
