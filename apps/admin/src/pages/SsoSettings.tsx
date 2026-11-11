import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Chip, Switch } from "@shelfline/ui";
import { api, ApiError } from "../lib/api";
import { useLensLock } from "../state/lens";
import { ErrorBox, Field, PageHeader, Panel, Skeleton, TextInput } from "../ui";

interface Sso { configured: boolean; issuer?: string; clientId?: string; emailDomains?: string[]; enabled?: boolean; redirectUri: string }
const ERR: Record<string, string> = { sso_insecure_url: "The provider address must start with https://.", sso_issuer_mismatch: "That provider reports a different issuer than the address you gave.", sso_provider_unreachable: "Could not reach that provider. Check the address.", sso_bad_discovery: "That address does not look like an OpenID Connect provider.", sso_secret_required: "Enter the client secret." };

export function SsoSettings() {
  useLensLock(true);
  const qc = useQueryClient(); const q = useQuery({ queryKey: ["sso"], queryFn: () => api<Sso>("/sso") });
  const [f, setF] = useState<{ issuer: string; clientId: string; clientSecret: string; domains: string; enabled: boolean } | null>(null); const [err, setErr] = useState<string | null>(null); const [saved, setSaved] = useState(false);
  const d = q.data; const form = f ?? { issuer: d?.issuer ?? "", clientId: d?.clientId ?? "", clientSecret: "", domains: (d?.emailDomains ?? []).join(", "), enabled: d?.enabled ?? true };
  const set = (k: keyof typeof form) => (v: string | boolean) => setF({ ...form, [k]: v });
  const save = useMutation({
    mutationFn: () => api("/sso", { method: "PUT", body: { issuer: form.issuer.trim(), clientId: form.clientId.trim(), ...(form.clientSecret.trim() ? { clientSecret: form.clientSecret.trim() } : {}), emailDomains: form.domains.split(/[,\s]+/).filter(Boolean), enabled: form.enabled } }),
    onSuccess: () => { setSaved(true); setF(null); void qc.invalidateQueries({ queryKey: ["sso"] }); },
    onError: (e) => setErr(e instanceof ApiError ? ERR[e.code] ?? "Check the details and try again." : "Could not save."),
  });
  const remove = useMutation({ mutationFn: () => api("/sso", { method: "DELETE" }), onSuccess: () => { setF(null); void qc.invalidateQueries({ queryKey: ["sso"] }); } });
  return (<>
    <PageHeader title="Single sign-on" sub="Let people sign in with your company's identity provider (OpenID Connect)" actions={d?.configured && <Chip tone={d.enabled ? "ok" : undefined}>{d.enabled ? "On" : "Off"}</Chip>} />
    {q.isLoading ? <Skeleton rows={5} /> : q.isError ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : (
      <Panel title="Provider">
        <form className="stack" onSubmit={(e) => { e.preventDefault(); setErr(null); setSaved(false); save.mutate(); }}>
          <p className="muted">In your provider, register an application with this redirect address: <code data-testid="redirect-uri">{d!.redirectUri}</code>. People still need an account here first; signing in never creates one.</p>
          <div className="grid2"><Field id="sso-issuer" label="Provider address (issuer)"><TextInput id="sso-issuer" value={form.issuer} onChange={set("issuer") as (v: string) => void} placeholder="https://login.example.com" /></Field>
            <Field id="sso-client" label="Client id"><TextInput id="sso-client" value={form.clientId} onChange={set("clientId") as (v: string) => void} /></Field>
            <Field id="sso-secret" label="Client secret" hint={d!.configured ? "Leave blank to keep the saved secret." : undefined}><TextInput id="sso-secret" type="password" value={form.clientSecret} onChange={set("clientSecret") as (v: string) => void} autoComplete="off" /></Field>
            <Field id="sso-domains" label="Allowed email domains" hint="Optional. Comma separated; blank allows any."><TextInput id="sso-domains" value={form.domains} onChange={set("domains") as (v: string) => void} placeholder="example.com" /></Field></div>
          <Switch checked={form.enabled} onChange={set("enabled") as (v: boolean) => void}>Allow single sign-on</Switch>
          {err && <p className="err" role="alert">{err}</p>}{saved && <p className="muted" role="status">Saved.</p>}
          <div className="row-flex">{d!.configured && <Button variant="ghost" onClick={() => remove.mutate()}>Remove</Button>}<span className="grow" /><Button variant="primary" type="submit" disabled={save.isPending || !form.issuer.trim() || !form.clientId.trim() || (!d!.configured && !form.clientSecret.trim())}>Save</Button></div>
        </form>
      </Panel>
    )}
  </>);
}
