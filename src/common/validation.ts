import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";
import { z } from "zod";
export const id = z.uuid();
export const text = z.string().trim().min(1).max(200);
export const date = z.iso.date();
export const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const minor = z
  .string()
  .regex(/^(0|[1-9]\d{0,12})$/)
  .refine(
    (v) => BigInt(v) <= 1000000000000n,
    "Amount exceeds supported maximum",
  );
export const version = z.number().int().positive();
export const phone = z
  .string()
  .regex(/^(?:\+880|0)1[3-9]\d{8}$/, "Enter a valid Bangladesh mobile number (e.g. 01712345678)")
  .transform((v) => (v.startsWith("0") ? "+88" + v : v));
export const listQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    search: z.string().trim().max(100).default(""),
    houseId: id.optional(),
    month: month.optional(),
    status: z.enum(["All", "Paid", "Partial", "Unpaid"]).optional(),
  })
  .strict();
export type ListQuery = z.infer<typeof listQuery>;
@Injectable()
export class Validate implements PipeTransform {
  constructor(private schema: z.ZodType) {}
  transform(value: unknown) {
    const r = this.schema.safeParse(value);
    if (!r.success)
      throw new BadRequestException({
        message: "Check the submitted fields",
        fieldErrors: r.error.flatten().fieldErrors,
      });
    return r.data;
  }
}
export const pageResult = <T>(rows: T[], total: number, q: ListQuery) => ({
  data: rows,
  meta: {
    page: q.page,
    limit: q.limit,
    total,
    pages: Math.ceil(total / q.limit),
  },
});
