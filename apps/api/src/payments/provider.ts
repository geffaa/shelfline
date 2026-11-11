/** What the server needs from a card terminal backend: send an amount to a reader, ask how it went, call it off. */
export type CardStatus = "processing" | "succeeded" | "failed" | "canceled";
export interface CardOutcome { status: CardStatus; failure?: string; brand?: string; last4?: string }
export interface CardRequest { amountMinor: number; currency: string; readerId: string; idempotencyKey: string; reference: string }
export interface CardProvider {
  readonly name: string;
  send(r: CardRequest): Promise<{ providerRef: string }>;
  status(providerRef: string, ctx: { createdAt: Date; amountMinor: number; readerId: string }): Promise<CardOutcome>;
  cancel(providerRef: string, ctx: { readerId: string }): Promise<void>;
}

/**
 * A terminal that is not there. The amount decides what happens, so every outcome can be shown and tested without hardware:
 * cents ending in 13 are declined, ending in 77 wait for a customer who never taps (cancel it), anything else is approved after a short pause.
 * The state is worked out from the time the request was made, so there is nothing to lose when the server restarts.
 */
export class SimulatedCardProvider implements CardProvider {
  readonly name = "simulated";
  constructor(private delayMs = 2000, private now: () => number = Date.now) {}
  async send(r: CardRequest) { return { providerRef: `sim_${r.idempotencyKey}` }; }
  async status(ref: string, ctx: { createdAt: Date; amountMinor: number }): Promise<CardOutcome> {
    if (this.canceled.has(ref)) return { status: "canceled" };
    const cents = ctx.amountMinor % 100; if (cents === 77) return { status: "processing" };
    if (this.now() - ctx.createdAt.getTime() < this.delayMs) return { status: "processing" };
    return cents === 13 ? { status: "failed", failure: "card_declined" } : { status: "succeeded", brand: "visa", last4: "4242" };
  }
  private canceled = new Set<string>();
  async cancel(ref: string) { this.canceled.add(ref); }
}

/**
 * Stripe Terminal in server-driven mode: a PaymentIntent is created for the amount and handed to a registered reader; the reader collects the card;
 * we read the PaymentIntent to see how it went. Written from Stripe's public documentation and exercised against a stand-in server in the tests.
 * It has NOT been run against Stripe (see docs/HARDWARE-TESTS.md, V11): use a test-mode key and a simulated reader first.
 */
export class StripeTerminalProvider implements CardProvider {
  readonly name = "stripe";
  constructor(private key: string, private base = "https://api.stripe.com", private fetchFn: typeof fetch = fetch) {}
  private async call<T>(method: "GET" | "POST", path: string, form?: Record<string, string>, idem?: string): Promise<T> {
    const res = await this.fetchFn(this.base + path, { method, headers: { authorization: `Bearer ${this.key}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(idem ? { "idempotency-key": idem } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined, signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: string } };
    if (!res.ok) throw new Error(`stripe ${res.status}: ${body.error?.code ?? body.error?.message ?? "error"}`);
    return body;
  }
  async send(r: CardRequest) {
    const pi = await this.call<{ id: string }>("POST", "/v1/payment_intents", { amount: String(r.amountMinor), currency: r.currency.toLowerCase(), "payment_method_types[]": "card_present", capture_method: "automatic", "metadata[shelfline_reference]": r.reference }, `pi-${r.idempotencyKey}`);
    await this.call("POST", `/v1/terminal/readers/${encodeURIComponent(r.readerId)}/process_payment_intent`, { payment_intent: pi.id }, `proc-${r.idempotencyKey}`);
    return { providerRef: pi.id };
  }
  async status(ref: string): Promise<CardOutcome> {
    const pi = await this.call<{ status: string; last_payment_error?: { code?: string; message?: string }; latest_charge?: { payment_method_details?: { card_present?: { brand?: string; last4?: string } } } | string | null }>("GET", `/v1/payment_intents/${encodeURIComponent(ref)}?expand[]=latest_charge`);
    if (pi.status === "succeeded") { const c = typeof pi.latest_charge === "object" && pi.latest_charge ? pi.latest_charge.payment_method_details?.card_present : undefined; return { status: "succeeded", brand: c?.brand, last4: c?.last4 }; }
    if (pi.status === "canceled") return { status: "canceled" };
    if (pi.status === "requires_payment_method" && pi.last_payment_error) return { status: "failed", failure: pi.last_payment_error.code ?? pi.last_payment_error.message ?? "declined" };
    return { status: "processing" };
  }
  async cancel(ref: string, ctx: { readerId: string }) {
    await this.call("POST", `/v1/terminal/readers/${encodeURIComponent(ctx.readerId)}/cancel_action`).catch(() => undefined);
    await this.call("POST", `/v1/payment_intents/${encodeURIComponent(ref)}/cancel`).catch(() => undefined);
  }
}
