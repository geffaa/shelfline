import { useState } from "react";
import { Button } from "@shelfline/ui";
import { api, ApiError, setToken } from "../lib/api";
import { Field, TextInput } from "../ui";

/** S60: an email address, then the code that was sent to it. The first step answers the same whoever types what, so it can't be used to find out who has access. */
export function SignIn({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<"email" | "code">("email"); const [email, setEmail] = useState(""); const [code, setCode] = useState(""); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const ask = async () => { setBusy(true); setErr(null); try { await api("/portal/auth/request-code", { method: "POST", body: { email: email.trim() } }); setStep("code"); } catch (e) { setErr(e instanceof ApiError && e.status === 400 ? "That does not look like an email address." : "Could not reach the server. Try again."); } finally { setBusy(false); } };
  const verify = async () => {
    setBusy(true); setErr(null);
    try { const r = await api<{ token: string }>("/portal/auth/verify", { method: "POST", body: { email: email.trim(), code: code.trim() } }); setToken(r.token); onDone(); }
    catch (e) { setErr(e instanceof ApiError && e.status === 429 ? "Too many wrong codes. Ask for a new code." : e instanceof ApiError && (e.status === 401 || e.status === 400) ? "That code is not right, or it has expired." : "Could not reach the server. Try again."); setCode(""); }
    finally { setBusy(false); }
  };
  return (
    <div className="screen-center">
      <div className="card-auth">
        <h1>Shelfline Reports</h1>
        {step === "email" ? (
          <form className="stack" aria-label="Sign in" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
            <p className="muted" style={{ margin: 0 }}>Enter the email address you were invited with. We will send you a one-time code.</p>
            <Field id="pt-email" label="Email"><TextInput id="pt-email" type="email" autoComplete="email" value={email} onChange={setEmail} autoFocus /></Field>
            {err && <p className="err" role="alert">{err}</p>}
            <Button variant="primary" type="submit" disabled={!/.+@.+\..+/.test(email) || busy}>Send me a code</Button>
          </form>
        ) : (
          <form className="stack" aria-label="Confirm your sign-in" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
            <p style={{ margin: 0 }} role="status">If <b>{email.trim()}</b> has access, a 6-digit code is on its way. It works once and expires in 10 minutes.</p>
            <div className="field-in code-input"><label htmlFor="pt-code">Code</label><div className="input"><input id="pt-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus /></div></div>
            {err && <p className="err" role="alert">{err}</p>}
            <Button variant="primary" type="submit" disabled={code.length !== 6 || busy}>Sign in</Button>
            <Button type="button" variant="ghost" onClick={() => { setStep("email"); setCode(""); setErr(null); }}>Use another email or send a new code</Button>
          </form>
        )}
      </div>
    </div>
  );
}
