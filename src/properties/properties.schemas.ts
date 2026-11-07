import { z } from "zod";
import { text, id, minor, version, date } from "../common/validation.js";
export const houseInput = z
  .object({
    name: text,
    address: text,
    managerIds: z.array(id).max(20).default([]),
  })
  .strict();
export const houseEdit = houseInput.extend({ version }).strict();
export const roomInput = z
  .object({
    houseId: id,
    number: text,
    rentMinor: minor,
    meter: z.string().trim().max(80).optional(),
    installedAt: date.optional(),
  })
  .strict();
export const roomEdit = z
  .object({ number: text, rentMinor: minor, version })
  .strict();
export const actionInput = z.object({ version }).strict();
export const assignmentInput = z
  .object({ managerIds: z.array(id).max(20), version })
  .strict();
export const meterInput = z
  .object({
    serial: text,
    installedAt: date,
    baseline: z.string().regex(/^\d{1,11}(\.\d{1,3})?$/),
  })
  .strict();
