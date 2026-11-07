import "dotenv/config";
import { Pool } from "pg";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  statement_timeout: 10000,
});
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
  });
async function consume() {
  const c = await pool.connect();
  let eventId: string | undefined;
  try {
    await c.query("BEGIN");
    const event = (
      await c.query(
        "SELECT * FROM outbox_events WHERE processed_at IS NULL AND attempts<5 AND next_attempt_at<=now() ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!event) {
      await c.query("COMMIT");
      return false;
    }
    eventId = event.id;
    const claim = await c.query(
      "INSERT INTO processed_events(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id",
      [event.id],
    );
    if (claim.rowCount) {
      console.info(
        JSON.stringify({
          eventId: event.id,
          type: event.type,
          action: "committed-domain-event",
        }),
      );
    }
    await c.query(
      "UPDATE outbox_events SET processed_at=now(),last_error=NULL WHERE id=$1",
      [event.id],
    );
    await c.query("COMMIT");
    return true;
  } catch (e) {
    await c.query("ROLLBACK");
    if (eventId)
      await pool.query(
        "UPDATE outbox_events SET attempts=attempts+1,next_attempt_at=now()+interval '30 seconds'*(attempts+1),last_error=$2 WHERE id=$1",
        [eventId, (e as Error).message.slice(0, 500)],
      );
    throw e;
  } finally {
    c.release();
  }
}
async function reconcile() {
  const rows = (
    await pool.query(
      `SELECT b.id FROM bills b LEFT JOIN LATERAL(SELECT COALESCE(sum(CASE WHEN kind='PAYMENT' THEN amount_minor ELSE -amount_minor END),0) AS actual FROM payments p WHERE p.bill_id=b.id) ledger ON true WHERE b.paid_minor<>ledger.actual LIMIT 100`,
    )
  ).rows;
  if (rows.length)
    console.error(
      JSON.stringify({
        event: "ledger.reconciliation.failed",
        billIds: rows.map((x) => x.id),
      }),
    );
}
let lastReconcile = 0;
while (!stopping) {
  try {
    const worked = await consume();
    if (Date.now() - lastReconcile > 300000) {
      await reconcile();
      lastReconcile = Date.now();
    }
    if (!worked) await new Promise((r) => setTimeout(r, 1000));
  } catch (e) {
    console.error("Worker error", (e as Error).message);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
await pool.end();
