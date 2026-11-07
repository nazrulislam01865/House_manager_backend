import { z } from "zod";
import { id, date, month, minor, text, version } from "../common/validation.js";
export const decimal = z.string().regex(/^\d{1,10}(\.\d{1,3})?$/);
export const rentRun = z
  .object({ houseId: id, month, dueDay: z.number().int().min(1).max(28) })
  .strict();
export const rateInput = z
  .object({
    houseId: id,
    effectiveFrom: date,
    rate: z.string().regex(/^\d{1,8}(\.\d{1,4})?$/),
  })
  .strict();
export const baselineInput = z
  .object({ roomId: id, date, reading: decimal })
  .strict();
export const electricityInput = z
  .object({
    roomId: id,
    month,
    readAt: date,
    current: decimal,
    previousReadingId: id.optional(),
    tariffId: id.optional(),
  })
  .strict();
export const electricityIssue = electricityInput
  .extend({ previousReadingId: id, tariffId: id })
  .strict();
export const correctionInput = z
  .object({
    amountMinor: minor.optional(),
    current: decimal.optional(),
    reason: text,
    version,
  })
  .strict();
export const voidInput = z.object({ reason: text, version }).strict();
