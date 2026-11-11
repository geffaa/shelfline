import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";

/** A stand-in OpenID Connect provider: discovery, published keys, and a token endpoint that checks the secret and the PKCE verifier like a real one. */
export class FakeIdp {
  constructor(public port = 19500) {} get issuer() { return `http://127.0.0.1:${this.port}`; } loginAs = ""; clientId = "shelfline-client"; clientSecret = "idp-client-secret-xyz";
  server!: http.Server; priv!: CryptoKey; jwk!: JWK; other!: CryptoKey; codes = new Map<string, { email: string; nonce: string; challenge: string; used: boolean }>(); tamper: Record<string, unknown> = {}; tokenCalls = 0; down = false;
  async start() {
    const kp = await generateKeyPair("RS256"); this.priv = kp.privateKey; this.jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" }; this.other = (await generateKeyPair("RS256")).privateKey;
    this.server = http.createServer((req, res) => { let body = ""; req.on("data", (c) => (body += c)); req.on("end", async () => {
      const json = (o: unknown, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (this.down) { res.writeHead(503); return res.end(); }
      if (req.url === "/.well-known/openid-configuration") return json({ issuer: this.tamper.discoveryIssuer ?? this.issuer, authorization_endpoint: `${this.issuer}/authorize`, token_endpoint: `${this.issuer}/token`, jwks_uri: `${this.issuer}/jwks` });
      if (req.url?.startsWith("/authorize")) { const q = new URL(req.url, this.issuer).searchParams; if (!this.loginAs) { res.writeHead(400); return res.end("nobody to sign in"); } const { code, state } = this.approve(req.url ? this.issuer + req.url : "", this.loginAs); const back = new URL(q.get("redirect_uri")!); back.searchParams.set("code", code); back.searchParams.set("state", state); res.writeHead(302, { location: back.toString() }); return res.end(); }
      if (req.url === "/jwks") return json({ keys: [this.jwk] });
      if (req.url === "/token" && req.method === "POST") {
        this.tokenCalls++; const f = new URLSearchParams(body); const auth = Buffer.from((req.headers.authorization ?? "").replace("Basic ", ""), "base64").toString(); const c = this.codes.get(f.get("code") ?? "");
        if (auth !== `${this.clientId}:${this.clientSecret}` || !c || c.used || createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") !== c.challenge || f.get("grant_type") !== "authorization_code") return json({ error: "invalid_grant" }, 400);
        c.used = true; const t = this.tamper; const now = Math.floor(Date.now() / 1000);
        const jwt = new SignJWT({ email: t.noEmail ? undefined : c.email, email_verified: t.emailVerified ?? true, name: "Signed In", nonce: t.nonce ?? c.nonce }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer((t.iss as string) ?? this.issuer).setAudience((t.aud as string) ?? this.clientId).setSubject("idp|1").setIssuedAt(now - 5).setExpirationTime(t.expired ? now - 3600 : now + 300);
        return json({ access_token: "x", token_type: "Bearer", id_token: await jwt.sign(t.wrongKey ? this.other : this.priv) });
      }
      json({}, 404); }); });
    await new Promise<void>((ok) => this.server.listen(this.port, "127.0.0.1", ok));
  }
  /** The person signs in at the provider; it hands the browser a code bound to the nonce and the PKCE challenge it was given. */
  approve(authUrl: string, email: string) { const q = new URL(authUrl).searchParams; const code = randomUUID(); this.codes.set(code, { email, nonce: q.get("nonce")!, challenge: q.get("code_challenge")!, used: false }); return { code, state: q.get("state")! }; }
  stop() { this.server.close(); }
}
