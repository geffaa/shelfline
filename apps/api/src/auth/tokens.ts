import { Inject, Injectable } from "@nestjs/common";
import { SignJWT, jwtVerify } from "jose";
import { CONFIG, type Config } from "../config";

export type Audience = "admin" | "pos" | "portal";
export interface TokenClaims { sub: string; org: string; aud: Audience; dev?: string; at?: number }

@Injectable()
export class TokenService {
  private key: Uint8Array;
  constructor(@Inject(CONFIG) private cfg: Config) { this.key = new TextEncoder().encode(cfg.jwtSecret); }

  async issue(c: { userId: string; orgId: string; aud: Audience; deviceId?: string; authAt?: number }): Promise<{ token: string; expiresInSec: number }> {
    const ttl = c.aud === "pos" ? this.cfg.posTokenTtlSec : c.aud === "portal" ? 60 * 60 : this.cfg.adminTokenTtlSec;
    const jwt = new SignJWT({ org: c.orgId, ...(c.deviceId ? { dev: c.deviceId } : {}), at: c.authAt ?? Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: "HS256" }).setSubject(c.userId).setAudience(c.aud).setIssuedAt().setExpirationTime(`${ttl}s`);
    return { token: await jwt.sign(this.key), expiresInSec: ttl };
  }

  async issueApproval(c: { approverId: string; orgId: string; deviceId: string; locationId: string; kind: string }): Promise<string> {
    return new SignJWT({ org: c.orgId, dev: c.deviceId, loc: c.locationId, kind: c.kind }).setProtectedHeader({ alg: "HS256" }).setSubject(c.approverId).setAudience("approval").setIssuedAt().setExpirationTime("10m").sign(this.key);
  }
  /** Returns the approver id if the token is valid, unexpired, and was issued for this device and location. */
  async verifyApproval(token: string, expect: { orgId: string; deviceId: string; locationId: string; kind: string }): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"], audience: "approval" });
      return payload.sub && payload.org === expect.orgId && payload.dev === expect.deviceId && payload.loc === expect.locationId && payload.kind === expect.kind ? payload.sub : null;
    } catch { return null; }
  }

  async verify(token: string, allowed: Audience[]): Promise<TokenClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ["HS256"], audience: allowed });
      if (!payload.sub || typeof payload.org !== "string") return null;
      return { sub: payload.sub, org: payload.org, aud: payload.aud as Audience, dev: typeof payload.dev === "string" ? payload.dev : undefined, at: typeof payload.at === "number" ? payload.at : undefined };
    } catch { return null; }
  }
}
