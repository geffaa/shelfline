import { useState } from "react";
import { Delete, Check, Store, WifiOff } from "lucide-react";
import { Button, Callout, Keypad, PinDots, Stepper } from "@shelfline/ui";
import { ApiError, OfflineError } from "../lib/api";
import { fmt } from "../lib/format";
import { defaultApiUrl } from "../state/config";
import { useApp } from "../state/app";

export function Brand() { return <div className="brand"><span className="mk"><Store size={18} /></span>Shelfline</div>; }

export function Pair() {
  const { pair } = useApp();
  const [apiUrl, setApiUrl] = useState(defaultApiUrl()); const [key, setKey] = useState("");
  return (
    <main className="screen-center"><form className="card-auth" onSubmit={(e) => { e.preventDefault(); pair({ apiUrl: apiUrl.replace(/\/+$/, ""), deviceKey: key.trim() }); }}>
      <Brand /><h1>Pair this iPad</h1>
      <p className="muted" style={{ margin: 0 }}>An owner creates a POS device in the back office and gives you its key. The key stays on this iPad.</p>
      <div className="field-in"><label htmlFor="api">Server address</label><div className="input"><input id="api" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} inputMode="url" autoCapitalize="none" autoCorrect="off" required /></div></div>
      <div className="field-in"><label htmlFor="key">Device key</label><div className="input"><input id="key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="slk_…" autoCapitalize="none" autoCorrect="off" required /></div></div>
      <Button variant="primary" size="lg" type="submit" disabled={!key.trim()}>Pair this iPad</Button>
    </form></main>
  );
}

export function SignIn() {
  const { signIn, sync, device, unpair } = useApp();
  const [code, setCode] = useState(""); const [pin, setPin] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!code.trim() || pin.length < 4 || busy) return; setBusy(true); setErr(null);
    try { await signIn(code.trim(), pin); }
    catch (e) {
      setPin("");
      if (e instanceof OfflineError) setErr("This iPad is offline. Signing in needs the network; a cashier who is already signed in can keep selling.");
      else if (e instanceof ApiError && e.status === 423) setErr("Too many wrong PINs. Ask a manager to reset it.");
      else if (e instanceof ApiError && e.status === 403) setErr("You are not assigned to this location.");
      else if (e instanceof ApiError && e.code === "device_invalid") setErr("This device key is not valid. Pair the iPad again.");
      else setErr("That code and PIN do not match.");
    } finally { setBusy(false); }
  };
  return (
    <main className="screen-center"><div className="card-auth">
      <Brand /><h1>{sync.authExpired ? "Sign in again" : "Sign in"}</h1>
      {sync.authExpired && <Callout tone="warn" icon={<WifiOff size={18} />}>Your session ended. {sync.queued} sale{sync.queued === 1 ? "" : "s"} saved on this iPad will send as soon as you sign in.</Callout>}
      <div className="field-in"><label htmlFor="code">Employee code</label><div className="input"><input id="code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="off" autoFocus /></div></div>
      <div className="stack" style={{ justifyItems: "center" }}>
        <PinDots length={Math.max(4, pin.length)} filled={pin.length} />
        <Keypad listen={false} disabled={busy} onDigit={(d) => setPin((p) => (p.length < 8 ? p + d : p))} onBackspace={() => setPin((p) => p.slice(0, -1))} onSubmit={pin.length >= 4 && code.trim() ? submit : undefined} submitLabel="Sign in" backspaceIcon={<Delete size={22} />} submitIcon={<Check size={24} />} />
      </div>
      {err && <p className="err" role="alert" style={{ margin: 0 }}>{err}</p>}
      <Button variant="ghost" size="sm" onClick={() => { if (confirm(`Unpair this iPad from ${device?.apiUrl}? Sales not yet sent stay on the iPad.`)) unpair(); }}>Unpair this iPad</Button>
    </div></main>
  );
}

export function Loading() {
  const { sync } = useApp();
  return <main className="screen-center"><div className="card-auth"><Brand /><h1>Getting the catalogue ready</h1>
    {sync.state === "offline" ? <Callout tone="warn" icon={<WifiOff size={18} />}>The iPad is offline and has no catalogue yet. Connect it once to download products, prices and stock; after that it works without a network.</Callout> : <p className="muted" style={{ margin: 0 }}>Downloading products, prices and stock for this store…</p>}
  </div></main>;
}

export const DENOMS = [{ c: 10000, n: "A$100" }, { c: 5000, n: "A$50" }, { c: 2000, n: "A$20" }, { c: 1000, n: "A$10" }, { c: 500, n: "A$5" }, { c: 200, n: "A$2" }, { c: 100, n: "A$1" }, { c: 50, n: "50c" }, { c: 20, n: "20c" }, { c: 10, n: "10c" }, { c: 5, n: "5c" }];
export function OpenRegister() {
  const { openSession, auth, catalogue, signOut } = useApp();
  const [counts, setCounts] = useState<Record<string, number>>({}); const [busy, setBusy] = useState(false);
  const total = DENOMS.reduce((a, d) => a + d.c * (counts[d.c] ?? 0), 0);
  return (
    <main className="screen-center"><div className="card-auth" style={{ width: "min(860px,100%)" }}>
      <Brand /><h1>Open the register</h1>
      <p className="muted" style={{ margin: 0 }}>{catalogue?.register?.code ?? "Register"} · {catalogue?.location?.name} · {auth?.name}. Count the cash in the drawer by denomination.</p>
      <div className="denoms">{DENOMS.map((d) => (
        <div className="denom" key={d.c}><span>{d.n}</span><Stepper label={`${d.n} count`} value={counts[d.c] ?? 0} onChange={(n) => setCounts((c) => ({ ...c, [d.c]: n }))} min={0} max={999} decrementIcon={<span aria-hidden>−</span>} incrementIcon={<span aria-hidden>+</span>} /><b className="num">{fmt(d.c * (counts[d.c] ?? 0))}</b></div>))}</div>
      <div className="row-flex" style={{ justifyContent: "space-between" }}><span>Opening float</span><span className="num-big">{fmt(total)}</span></div>
      <div className="row-flex"><Button variant="ghost" onClick={signOut}>Not me</Button><span className="grow" /><Button variant="primary" size="lg" disabled={busy} onClick={async () => { setBusy(true); await openSession(total, Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0))); }}>Open register with {fmt(total)}</Button></div>
    </div></main>
  );
}
