import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, setOnUnauthorized, setToken } from "../lib/api";

export interface Me { user: { id: string; email: string; name: string; totpEnabled: boolean }; assignments: { role: string; locationId: string | null; locationName: string | null; permissions: string[] }[] }
interface Ctx {
  me: Me | null; ready: boolean; login(email: string, password: string, totp?: string, org?: string): Promise<void>; loginWithToken(token: string): Promise<void>; logout(): void;
  can(permission: string, locationId?: string | null): boolean; canAny(permission: string): boolean;
}
const AuthContext = createContext<Ctx | null>(null);
export const useAuth = () => { const c = useContext(AuthContext); if (!c) throw new Error("AuthProvider missing"); return c; };
const KEY = "shelfline.admin.token";
const store = { get: () => { try { return sessionStorage.getItem(KEY); } catch { return null; } }, set: (v: string | null) => { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch { /* private mode */ } } };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null); const [ready, setReady] = useState(false); const qc = useQueryClient();
  const logout = useCallback(() => { setToken(null); store.set(null); setMe(null); qc.clear(); }, [qc]);
  useEffect(() => { setOnUnauthorized(() => logout()); }, [logout]);
  useEffect(() => { // resume a session after a reload
    const t = store.get(); if (!t) { setReady(true); return; }
    setToken(t); api<Me>("/auth/me").then(setMe).catch(() => { setToken(null); store.set(null); }).finally(() => setReady(true));
  }, []);
  useEffect(() => { // sliding session: refresh well before the 15-minute token ends, up to the server's 8-hour limit
    if (!me) return; const t = setInterval(() => { api<{ token: string }>("/auth/refresh", { method: "POST" }).then((r) => { setToken(r.token); store.set(r.token); }).catch((e) => { if (e instanceof ApiError && e.status === 401) logout(); }); }, 9 * 60_000);
    return () => clearInterval(t);
  }, [me, logout]);
  const value = useMemo<Ctx>(() => ({
    me, ready, logout,
    login: async (email, password, totp, org) => { const r = await api<{ token: string }>("/auth/login", { method: "POST", body: { email, password, ...(totp ? { totp } : {}), ...(org ? { org } : {}) } }); setToken(r.token); store.set(r.token); setMe(await api<Me>("/auth/me")); },
    loginWithToken: async (token) => { setToken(token); store.set(token); try { setMe(await api<Me>("/auth/me")); } catch (e) { setToken(null); store.set(null); throw e; } },
    canAny: (p) => !!me?.assignments.some((a) => a.permissions.includes(p)),
    can: (p, loc) => !!me?.assignments.some((a) => a.permissions.includes(p) && (a.locationId === null || (!!loc && a.locationId === loc))),
  }), [me, ready, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
