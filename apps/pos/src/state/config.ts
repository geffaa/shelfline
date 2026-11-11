export interface AuthState { token: string; expiresAt: number; userId: string; name: string; employeeCode: string; locationId: string; registerId: string | null; canApprove: boolean }
export interface DeviceConfig { apiUrl: string; deviceKey: string }

const K = { device: "shelfline.device", auth: "shelfline.auth" };
const read = <T,>(key: string): T | null => { try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : null; } catch { return null; } };
const write = (key: string, v: unknown) => { try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode: the app still works for this session */ } };

export const defaultApiUrl = () => import.meta.env.VITE_API_URL ?? "http://localhost:8200";
export const loadDevice = () => read<DeviceConfig>(K.device);
export const saveDevice = (d: DeviceConfig | null) => write(K.device, d);
/** A token past its expiry is still kept so the till can show who was signed in, but it is not used to sign requests. */
export const loadAuth = () => read<AuthState>(K.auth);
export const saveAuth = (a: AuthState | null) => write(K.auth, a);
