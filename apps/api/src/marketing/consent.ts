import { consentEvent } from "../db/schema";
import type { Tx } from "../inventory/ledger.service";

/** Writes a line to the consent history whenever the answer to "may we email this person?" changes, including the first time it is given. Call inside the transaction that changes it. */
export async function logConsent(tx: Pick<Tx, "insert">, o: { orgId: string; customerId: string; before: { email?: boolean } | null | undefined; after: { email?: boolean } | null | undefined; source: string; actorId?: string | null }) {
  const was = o.before?.email, is = o.after?.email; if (was === is) return;
  await tx.insert(consentEvent).values({ orgId: o.orgId, customerId: o.customerId, channel: "email", granted: is === true, source: o.source, actorId: o.actorId ?? null });
}
