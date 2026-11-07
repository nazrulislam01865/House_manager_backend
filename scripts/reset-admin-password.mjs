/** Explicit, owner-initiated credential reset for a pre-existing admin. */
import "dotenv/config";
import { Pool } from "pg";
import { hash } from "argon2";
if (process.env.ADMIN_RESET_CONFIRM !== "RESET_MY_ADMIN_PASSWORD")
  throw Error("Set ADMIN_RESET_CONFIRM=RESET_MY_ADMIN_PASSWORD only for an intentional admin credential reset");
const phoneInput = process.env.ADMIN_PHONE || "";
const phone = phoneInput.startsWith("0") ? "+88" + phoneInput : phoneInput;
const username = (process.env.ADMIN_USERNAME || "admin").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || "";
if (!/^\+8801[3-9]\d{8}$/.test(phone) || !/^[a-z][a-z0-9._-]{2,39}$/.test(username) || password.length < 12)
  throw Error("Set valid ADMIN_PHONE, ADMIN_USERNAME and ADMIN_PASSWORD (12+ characters) in .env");
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");
const newHash = await hash(password);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const result = await client.query(
    "SELECT id,organization_id FROM users WHERE role='ADMIN' AND phone=$1 AND active FOR UPDATE",
    [phone],
  );
  if (result.rowCount !== 1) throw Error("Matching active admin not found; nothing changed");
  const u = result.rows[0];
  await client.query(
    "UPDATE users SET username=$1,password_hash=$2,version=version+1 WHERE id=$3",
    [username, newHash, u.id],
  );
  await client.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
  await client.query(
    "INSERT INTO audit_events(organization_id,actor_id,action) VALUES($1,$2,'admin.credentials_reset')",
    [u.organization_id, u.id],
  );
  await client.query("COMMIT");
  console.log("Admin credentials replaced from .env; previous web sessions revoked.");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
  await pool.end();
}
