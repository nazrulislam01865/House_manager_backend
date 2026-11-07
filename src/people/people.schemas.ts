import { z } from "zod";
import { text, phone, id, date, minor, version } from "../common/validation.js";
// NID is a string: preserve leading zeros and do not convert to a number.
export const nid = z.string().trim().regex(/^(?:\d{10}|\d{13}|\d{17})$/, "NID must contain 10, 13 or 17 digits");
export const managerPassword = z.string().regex(/^\d{8}$/, "App password must contain exactly 8 numeric digits");
export const managerInput = z
  .object({ name: text, phone, nid, password: managerPassword })
  .strict();
export const managerEdit = z
  .object({ name: text, phone, nid: nid.optional(), active: z.boolean(), version, password: managerPassword.optional() })
  .strict();
export const residentInput = z
  .object({ name: text, phone, roomId: id, startDate: date, rentMinor: minor })
  .strict();
export const residentEdit = z
  .object({ name: text, phone, version, active: z.boolean().optional() })
  .strict();
export const endInput = z.object({ endDate: date, reason: text }).strict();
export const moveInput = z
  .object({ roomId: id, effectiveDate: date, rentMinor: minor })
  .strict();
export const termsInput = z
  .object({ effectiveFrom: date, amountMinor: minor })
  .strict();

export const allocationInput = z
  .object({ residentId: id, roomId: id, startDate: date, rentMinor: minor })
  .strict();
