import { useEffect, useRef, useState } from "react";
import { Store } from "lucide-react";
import { Button } from "@shelfline/ui";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../state/auth";
import { Field, TextInput } from "../ui";

type Mode = "password" | "totp" | "org" | "sso";

export function SignIn() {
  const { login } = useAuth(); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [totp, setTotp] = useState(""); const [org, setOrg] = useState(""); const [mode, setMode] = useState<Mode>("password"); const [orgs, setOrgs] = useState<{ slug: string; name: string }[]>([]); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    if (mode === "sso") {
      try { const r = await api<{ url: string }>(`/auth/sso/start?org=${encodeURIComponent(org.trim().toLowerCase())}`); window.location.assign(r.url); return; }
      catch (x) { setErr(x instanceof ApiError && x.status === 404 ? "That organisation does not use single sign-on, or the name is wrong." : x instanceof ApiError && x.status === 0 ? "Cannot reach the server. Check your connection." : "Single sign-on is not working right now. Use your password, or ask your administrator."); setBusy(false); return; }
    }
    try { await login(email.trim(), password, mode === "totp" ? totp : undefined, mode === "org" || org ? org : undefined); }
    catch (x) {
      if (x instanceof ApiError && x.code === "totp_required") { setMode("totp"); setErr(null); }
      else if (x instanceof ApiError && x.code === "choose_org") { setOrgs(x.body?.orgs ?? []); setMode("org"); setErr(null); }
      else if (x instanceof ApiError && x.status === 429) setErr("Too many attempts. Wait a minute and try again.");
      else if (x instanceof ApiError && x.status === 0) setErr("Cannot reach the server. Check your connection.");
      else setErr(mode === "totp" ? "That code is not right, or the password has changed." : "That email and password do not match.");
    } finally { setBusy(false); }
  };
  const valid = mode === "totp" ? totp.length === 6 : mode === "sso" ? org.trim().length >= 2 : mode === "org" ? !!org : !!email && !!password;
  return (
    <main className="screen-center"><form className="card-auth" onSubmit={submit} aria-label="Sign in">
      <div className="brand"><span className="mk"><Store size={16} /></span>Shelfline</div>
      <h1>{mode === "totp" ? "Two-step check" : mode === "org" ? "Which organisation?" : mode === "sso" ? "Single sign-on" : "Sign in"}</h1>
      {mode === "password" && <>
        <Field id="email" label="Email"><TextInput id="email" type="email" value={email} onChange={setEmail} autoComplete="username" autoFocus required /></Field>
        <Field id="password" label="Password"><TextInput id="password" type="password" value={password} onChange={setPassword} autoComplete="current-password" required /></Field>
      </>}
      {mode === "totp" && <Field id="totp" label="6-digit code from your authenticator app" hint="Codes change every 30 seconds."><TextInput id="totp" value={totp} onChange={(v) => setTotp(v.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" autoFocus /></Field>}
      {mode === "org" && <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}><legend className="lbl">That email and password belong to more than one organisation.</legend>{orgs.map((o) => <Button key={o.slug} variant={org === o.slug ? "primary" : "secondary"} onClick={() => setOrg(o.slug)}>{o.name}</Button>)}</fieldset>}
      {mode === "sso" && <Field id="org" label="Organisation" hint="The short name your administrator gave you, for example kestrel-run-co."><TextInput id="org" value={org} onChange={setOrg} autoFocus autoComplete="organization" /></Field>}
      {err && <p className="err" role="alert">{err}</p>}
      <Button variant="primary" size="lg" type="submit" disabled={busy || !valid}>{mode === "totp" ? "Verify" : mode === "sso" ? "Continue to your provider" : mode === "org" ? "Sign in" : "Sign in"}</Button>
      {mode === "password" && <Button variant="ghost" onClick={() => { setMode("sso"); setErr(null); }}>Use single sign-on</Button>}
      {mode !== "password" && <Button variant="ghost" onClick={() => { setMode("password"); setTotp(""); setErr(null); }}>Back</Button>}
    </form></main>
  );
}

/** Where the identity provider sends the browser back to. Trades the one-time ticket for a sign-in and moves on; a failure is a plain page with a way out. */
export function SsoComplete() {
  const { loginWithToken } = useAuth(); const [err, setErr] = useState<string | null>(null); const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return; ran.current = true; // the ticket works once, so a second effect run must not spend it again
    const q = new URLSearchParams(window.location.hash.split("?")[1] ?? ""); const ticket = q.get("ticket"); const error = q.get("error");
    if (!ticket) { setErr(error === "not_allowed" ? "Your provider signed you in, but this organisation has no active account for that email. Ask your administrator to add you." : error === "provider_refused" ? "Sign-in was cancelled at your provider." : "Single sign-on did not complete. Try again, or use your password."); return; }
    api<{ token: string }>("/auth/sso/exchange", { method: "POST", body: { ticket } }).then((r) => loginWithToken(r.token)).then(() => { window.location.hash = "#/today/overview"; }).catch(() => setErr("That sign-in link has expired or was already used. Start again."));
  }, [loginWithToken]);
  return (
    <main className="screen-center"><div className="card-auth" role="status">
      <div className="brand"><span className="mk"><Store size={16} /></span>Shelfline</div>
      {err ? <><h1>Could not sign you in</h1><p className="err" role="alert">{err}</p><a className="btn" href="#/today/overview" onClick={(e) => { e.preventDefault(); window.history.replaceState(null, "", window.location.pathname); window.location.reload(); }}>Back to sign in</a></> : <><h1>Signing you in…</h1><p className="muted">Finishing with your provider.</p></>}
    </div></main>
  );
}
