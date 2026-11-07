import {
  createParamDecorator,
  ExecutionContext,
  NotFoundException,
  ConflictException,
} from "@nestjs/common";
import type { Transaction } from "../database/database.service.js";
export type Actor = {
  id: string;
  organizationId: string;
  name: string;
  sessionId: string;
  csrfHash: string;
};
export const Current = createParamDecorator(
  (_data: unknown, c: ExecutionContext) =>
    (c.switchToHttp().getRequest() as { actor: Actor }).actor,
);
export async function one(c: Transaction, sql: string, args: unknown[]) {
  const r = (await c.query(sql, args)).rows[0];
  if (!r) throw new NotFoundException("Record not found");
  return r;
}
export function checkVersion(actual: number, expected: number) {
  if (actual !== expected)
    throw new ConflictException("Record changed. Refresh and try again.");
}
export async function audit(
  c: Transaction,
  a: Actor,
  action: string,
  resource: string | null,
  detail: unknown = {},
) {
  await c.query(
    "INSERT INTO audit_events(organization_id,actor_id,action,resource_id,detail) VALUES($1,$2,$3,$4,$5)",
    [a.organizationId, a.id, action, resource, JSON.stringify(detail)],
  );
}
export async function outbox(
  c: Transaction,
  a: Actor,
  type: string,
  payload: unknown,
) {
  await c.query(
    "INSERT INTO outbox_events(organization_id,type,payload) VALUES($1,$2,$3)",
    [a.organizationId, type, JSON.stringify(payload)],
  );
}
