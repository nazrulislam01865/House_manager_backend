import "dotenv/config";
import { Pool } from "pg";
import { hash } from "argon2";
const { ADMIN_NAME, ADMIN_PHONE, ADMIN_PASSWORD } = process.env;
const username = (process.env.ADMIN_USERNAME || "admin").trim().toLowerCase();
if (!ADMIN_NAME || !ADMIN_PHONE || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12)
  throw Error("Set ADMIN_NAME, ADMIN_PHONE and ADMIN_PASSWORD (minimum 12 characters) in backend .env");
if (!/^[a-z][a-z0-9._-]{2,39}$/.test(username))
  throw Error("ADMIN_USERNAME must start with a letter and be 3-40 letters/numbers/._- characters");
const phone = ADMIN_PHONE.startsWith("0") ? "+88" + ADMIN_PHONE : ADMIN_PHONE;
if (!/^\+8801[3-9]\d{8}$/.test(phone)) throw Error("Invalid Bangladesh phone");
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const c = await pool.connect();
try {
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(673108925)");
  const existing = await c.query("SELECT id,username FROM users WHERE role='ADMIN' LIMIT 1");
  if (existing.rowCount) {
    // A previous version created admins with phone only. Fill in the missing
    // username if and only if the configured phone identifies that same admin.
    const current = await c.query(
      "SELECT id,username FROM users WHERE id=$1 AND phone=$2",
      [existing.rows[0].id, phone],
    );
    if (current.rowCount && !current.rows[0].username) {
      await c.query("UPDATE users SET username=$1 WHERE id=$2", [username, current.rows[0].id]);
      console.log("Assigned ADMIN_USERNAME to existing admin. Existing password remains unchanged.");
    } else {
      console.log("Admin already exists; credentials untouched. Sign in with existing password.");
    }
  } else {
    const org = (
      await c.query("INSERT INTO organizations(name) VALUES($1) RETURNING id", [
        process.env.ORGANIZATION_NAME || "HouseLedger",
      ])
    ).rows[0];
    await c.query(
      "INSERT INTO users(organization_id,role,name,username,phone,password_hash) VALUES($1,'ADMIN',$2,$3,$4,$5)",
      [org.id, ADMIN_NAME, username, phone, await hash(ADMIN_PASSWORD)],
    );
    console.log("Admin created with credentials from .env (password stored as Argon2 hash).");
  }
  await c.query("COMMIT");
} catch (e) {
  await c.query("ROLLBACK");
  throw e;
} finally {
  c.release();
  await pool.end();
}
