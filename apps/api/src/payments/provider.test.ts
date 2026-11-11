import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SimulatedCardProvider, StripeTerminalProvider } from "./provider";
import { loadConfig } from "../config";

describe("the simulated terminal: the amount decides", () => {
  const ctx = (amountMinor: number, at = 0) => ({ createdAt: new Date(at), amountMinor, readerId: "r" });
  it("approves after a pause, declines cents ending in 13, and never answers for cents ending in 77", async () => {
    let now = 0; const p = new SimulatedCardProvider(1000, () => now); const ref = (await p.send({ amountMinor: 5000, currency: "AUD", readerId: "r", idempotencyKey: "k1", reference: "x" })).providerRef;
    expect(await p.status(ref, ctx(5000))).toEqual({ status: "processing" }); now = 999; expect((await p.status(ref, ctx(5000))).status).toBe("processing"); now = 1000; expect(await p.status(ref, ctx(5000))).toMatchObject({ status: "succeeded", brand: "visa", last4: "4242" });
    expect(await p.status(ref, ctx(2013))).toEqual({ status: "failed", failure: "card_declined" }); now = 99_999; expect(await p.status(ref, ctx(1077))).toEqual({ status: "processing" });
  });
  it("a cancelled payment stays cancelled", async () => { const p = new SimulatedCardProvider(0); const ref = (await p.send({ amountMinor: 1077, currency: "AUD", readerId: "r", idempotencyKey: "k2", reference: "x" })).providerRef; await p.cancel(ref); expect(await p.status(ref, ctx(1077))).toEqual({ status: "canceled" }); });
});

describe("Stripe Terminal, server-driven, against a stand-in for Stripe's API", () => {
  interface Req { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
  let srv: http.Server; const seen: Req[] = []; let respond: (r: Req) => { status?: number; json: unknown } = () => ({ json: {} });
  const start = async () => { srv = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { const r = { method: req.method!, url: req.url!, headers: req.headers, body: b }; seen.push(r); const o = respond(r); res.statusCode = o.status ?? 200; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o.json)); }); }); await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok)); return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`; };
  afterEach(() => { srv?.close(); seen.length = 0; });

  it("creates a card-present PaymentIntent for the amount, hands it to the reader, and sends idempotency keys and the key as a bearer token", async () => {
    const base = await start(); respond = (r) => ({ json: r.url === "/v1/payment_intents" ? { id: "pi_123" } : { id: "tmr_1" } }); const p = new StripeTerminalProvider("sk_test_abc", base);
    const out = await p.send({ amountMinor: 21995, currency: "AUD", readerId: "tmr_ABC", idempotencyKey: "11111111-1111-4111-8111-111111111111", reference: "ref-1" }); expect(out).toEqual({ providerRef: "pi_123" });
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /v1/payment_intents", "POST /v1/terminal/readers/tmr_ABC/process_payment_intent"]);
    const f = new URLSearchParams(seen[0]!.body); expect(f.get("amount")).toBe("21995"); expect(f.get("currency")).toBe("aud"); expect(f.get("payment_method_types[]")).toBe("card_present"); expect(f.get("capture_method")).toBe("automatic"); expect(f.get("metadata[shelfline_reference]")).toBe("ref-1");
    expect(new URLSearchParams(seen[1]!.body).get("payment_intent")).toBe("pi_123"); for (const r of seen) { expect(r.headers.authorization).toBe("Bearer sk_test_abc"); expect(r.headers["content-type"]).toBe("application/x-www-form-urlencoded"); }
    expect(seen[0]!.headers["idempotency-key"]).toBe("pi-11111111-1111-4111-8111-111111111111"); expect(seen[1]!.headers["idempotency-key"]).toBe("proc-11111111-1111-4111-8111-111111111111");
  });
  it("reads the PaymentIntent: processing, approved (with card brand and last four), declined, and cancelled", async () => {
    const base = await start(); const p = new StripeTerminalProvider("sk_test_abc", base); const answer = (j: unknown) => { respond = () => ({ json: j }); };
    answer({ status: "requires_payment_method" }); expect(await p.status("pi_1")).toEqual({ status: "processing" }); answer({ status: "processing" }); expect((await p.status("pi_1")).status).toBe("processing"); answer({ status: "requires_action" }); expect((await p.status("pi_1")).status).toBe("processing");
    answer({ status: "succeeded", latest_charge: { payment_method_details: { card_present: { brand: "mastercard", last4: "4444" } } } }); expect(await p.status("pi_1")).toEqual({ status: "succeeded", brand: "mastercard", last4: "4444" });
    answer({ status: "succeeded", latest_charge: "ch_unexpanded" }); expect(await p.status("pi_1")).toEqual({ status: "succeeded", brand: undefined, last4: undefined });
    answer({ status: "requires_payment_method", last_payment_error: { code: "card_declined", message: "Your card was declined." } }); expect(await p.status("pi_1")).toEqual({ status: "failed", failure: "card_declined" }); answer({ status: "canceled" }); expect((await p.status("pi_1")).status).toBe("canceled");
    expect(seen.at(-1)!.url).toBe("/v1/payment_intents/pi_1?expand[]=latest_charge"); expect(seen.at(-1)!.method).toBe("GET");
  });
  it("cancelling clears the reader and cancels the intent, and an error from Stripe is an error here", async () => {
    const base = await start(); const p = new StripeTerminalProvider("sk_test_abc", base); respond = () => ({ json: {} }); await p.cancel("pi_9", { readerId: "tmr_Z" });
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual(["POST /v1/terminal/readers/tmr_Z/cancel_action", "POST /v1/payment_intents/pi_9/cancel"]);
    respond = () => ({ status: 402, json: { error: { code: "terminal_reader_offline", message: "offline" } } }); await expect(p.send({ amountMinor: 100, currency: "AUD", readerId: "tmr_X", idempotencyKey: "k", reference: "r" })).rejects.toThrow("stripe 402: terminal_reader_offline");
  });
  it("is only used when asked for, and then needs a key", () => {
    const env = { JWT_SECRET: "x".repeat(40), ENCRYPTION_KEY: "11".repeat(32) }; expect(loadConfig({ ...env }).cardProvider).toBe("simulated"); expect(() => loadConfig({ ...env, CARD_PROVIDER: "stripe" })).toThrow("STRIPE_SECRET_KEY"); expect(loadConfig({ ...env, CARD_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_1" })).toMatchObject({ cardProvider: "stripe", stripeApiBase: "https://api.stripe.com" });
  });
});
