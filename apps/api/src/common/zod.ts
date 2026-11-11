import { BadRequestException } from "@nestjs/common";
import type { ZodType } from "zod";
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new BadRequestException({ code: "validation", issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  return r.data;
}
