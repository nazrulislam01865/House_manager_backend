import "dotenv/config";
import { Pool } from "pg";
import { readdir, readFile } from "node:fs/promises";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const c = await pool.connect();
try {
  await c.query("SELECT pg_advisory_lock(673108924)");
  await c.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of (await readdir(new URL("../migrations/", import.meta.url)))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    if (
      (await c.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]))
        .rowCount
    )
      continue;
    await c.query("BEGIN");
    try {
      await c.query(
        await readFile(
          new URL("../migrations/" + name, import.meta.url),
          "utf8",
        ),
      );
      await c.query("INSERT INTO schema_migrations(name) VALUES($1)", [name]);
      await c.query("COMMIT");
      console.log("Applied", name);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  }
} finally {
  await c.query("SELECT pg_advisory_unlock(673108924)");
  c.release();
  await pool.end();
}
