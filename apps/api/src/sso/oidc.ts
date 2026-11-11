import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** What we need from an OpenID Connect provider's discovery document. */
export interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
export class OidcError extends Error { constructor(public code: string, detail?: string) { super(detail ? `${code}: ${detail}` : code); } }

const b64url = (b: Buffer) => b.toString("base64url");
export const newVerifier = () => b64url(randomBytes(32));
export const challengeOf = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());
export const newNonce = () => b64url(randomBytes(16));

/** https only, except for a provider on this machine (development and tests). */
export function assertSafeUrl(u: string, what: string) {
  let url: URL; try { url = new URL(u); } catch { throw new OidcError("bad_url", what); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new OidcError("insecure_url", what);
  return url;
}

const cache = new Map<string, { at: number; d: Discovery }>(); const jwks = new Map<string, JWTVerifyGetKey>();
export function forgetProviders() { cache.clear(); jwks.clear(); }

export async function discover(issuer: string, f: typeof fetch = fetch): Promise<Discovery> {
  const hit = cache.get(issuer); if (hit && Date.now() - hit.at < 5 * 60_000) return hit.d;
  assertSafeUrl(issuer, "issuer");
  let res: Response; try { res = await f(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) }); } catch { throw new OidcError("provider_unreachable"); }
  if (!res.ok) throw new OidcError("provider_unreachable", String(res.status));
  const d = (await res.json()) as Partial<Discovery>;
  if (d.issuer !== issuer && d.issuer?.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) throw new OidcError("issuer_mismatch");           // a provider cannot speak for another issuer
  if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) throw new OidcError("bad_discovery");
  for (const [k, v] of Object.entries({ authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, jwks_uri: d.jwks_uri })) assertSafeUrl(v, k);
  const out = { issuer: d.issuer!, authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, jwks_uri: d.jwks_uri }; cache.set(issuer, { at: Date.now(), d: out }); return out;
}

export function authorizeUrl(d: Discovery, p: { clientId: string; redirectUri: string; state: string; nonce: string; verifier: string; loginHint?: string }) {
  const u = new URL(d.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: p.clientId, redirect_uri: p.redirectUri, scope: "openid email profile", state: p.state, nonce: p.nonce, code_challenge: challengeOf(p.verifier), code_challenge_method: "S256", ...(p.loginHint ? { login_hint: p.loginHint } : {}) })) u.searchParams.set(k, v);
  return u.toString();
}

export interface Identity { email: string; emailVerified: boolean; name: string | null; subject: string }

/** Trade the code for tokens and check the ID token: signature (provider's published keys), issuer, audience, expiry and our nonce. */
export async function exchangeCode(d: Discovery, p: { clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string; nonce: string }, f: typeof fetch = fetch): Promise<Identity> {
  let res: Response;
  try {
    res = await f(d.token_endpoint, { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${encodeURIComponent(p.clientId)}:${encodeURIComponent(p.clientSecret)}`).toString("base64")}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier, client_id: p.clientId }) });
  } catch { throw new OidcError("provider_unreachable"); }
  if (!res.ok) throw new OidcError("code_rejected", String(res.status));
  const t = (await res.json()) as { id_token?: string }; if (!t.id_token) throw new OidcError("no_id_token");
  let keys = jwks.get(d.jwks_uri); if (!keys) { keys = createRemoteJWKSet(new URL(d.jwks_uri), { timeoutDuration: 8000 }); jwks.set(d.jwks_uri, keys); }
  let claims: Record<string, unknown>;
  try { claims = (await jwtVerify(t.id_token, keys, { issuer: d.issuer, audience: p.clientId, algorithms: ["RS256", "ES256", "PS256"], clockTolerance: 30 })).payload as Record<string, unknown>; }
  catch (e) { throw new OidcError("id_token_invalid", e instanceof Error ? e.name : undefined); }
  if (claims.nonce !== p.nonce) throw new OidcError("nonce_mismatch");
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : ""; if (!email) throw new OidcError("no_email");
  return { email, emailVerified: claims.email_verified !== false && claims.email_verified !== "false", name: typeof claims.name === "string" ? claims.name : null, subject: String(claims.sub ?? "") };
}
