import { Inject, Injectable } from "@nestjs/common";
import { DB, type Db } from "../db/db.module";
import { emailOutbox } from "../db/schema";

/** No mail provider is connected yet (V14), so sending means writing to the outbox. In development that table is readable at `GET /dev/mailbox`. */
@Injectable()
export class MailService {
  constructor(@Inject(DB) private db: Db) {}
  async send(orgId: string, m: { to: string; subject: string; body: string; kind: string; attachment?: { name: string; type: string; base64: string } }, tx: Pick<Db, "insert"> = this.db) {
    await tx.insert(emailOutbox).values({ orgId, toEmail: m.to.toLowerCase(), subject: m.subject, body: m.body, kind: m.kind, attachmentName: m.attachment?.name ?? null, attachmentType: m.attachment?.type ?? null, attachmentBase64: m.attachment?.base64 ?? null });
  }
}
