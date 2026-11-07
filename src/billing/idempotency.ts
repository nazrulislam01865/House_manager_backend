import { BadRequestException, ConflictException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Transaction } from "../database/database.service.js";
import type { Actor } from "../common/context.js";
export async function idempotent<T>(
  c: Transaction,
  a: Actor,
  route: string,
  key: string | undefined,
  payload: unknown,
  work: () => Promise<T>,
): Promise<T> {
  if (!z.uuid().safeParse(key).success)
    throw new BadRequestException("Supply a UUID Idempotency-Key header");
  const args = [a.organizationId, a.id, route, key];
  const hash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  await c.query(
    "INSERT INTO idempotency_records(organization_id,actor_id,route,key,request_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [...args, hash],
  );
  const row = (
    await c.query(
      "SELECT request_hash,result FROM idempotency_records WHERE organization_id=$1 AND actor_id=$2 AND route=$3 AND key=$4 FOR UPDATE",
      args,
    )
  ).rows[0];
  if (row.request_hash !== hash)
    throw new ConflictException(
      "This idempotency key belongs to a different request",
    );
  if (row.result) return row.result as T;
  const result = await work();
  await c.query(
    "UPDATE idempotency_records SET result=$5 WHERE organization_id=$1 AND actor_id=$2 AND route=$3 AND key=$4",
    [...args, JSON.stringify(result)],
  );
  return result;
}
