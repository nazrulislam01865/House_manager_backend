import { Database } from "../database/database.service.js";
import { type ListQuery, pageResult } from "./validation.js";
export async function paginate(
  db: Database,
  sql: string,
  values: unknown[],
  q: ListQuery,
) {
  const count = await db.query(
    `SELECT count(*)::int AS n FROM (${sql}) counted`,
    values,
  );
  const rows = await db.query(
    `${sql} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, q.limit, (q.page - 1) * q.limit],
  );
  return pageResult(rows, count[0].n, q);
}
export const activeTenancy = `t.cancelled=false AND t.start_date<=(now() AT TIME ZONE 'Asia/Dhaka')::date AND (t.end_date IS NULL OR t.end_date>(now() AT TIME ZONE 'Asia/Dhaka')::date)`;
