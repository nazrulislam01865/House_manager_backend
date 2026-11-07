/** Isolated PostgreSQL fixture test: no developer database is modified. */
import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import assert from "node:assert/strict";

const dir = await mkdtemp(join(tmpdir(), "houseledger-demo-test-"));
const pg = new EmbeddedPostgres({
  databaseDir: dir, user: "postgres", password: "isolated-test-only",
  port: 55434, persistent: false, autoRehydrateSymlinks: true,
  onLog: () => {}, onError: () => {},
});
let pool;
async function exec(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", chunk => output += chunk);
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}
try {
  await pg.initialise();
  await appendFile(join(dir, "postgresql.conf"), "\nunix_socket_directories = ''\n");
  await pg.start();
  await pg.createDatabase("demo_test_db");
  const env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: "postgres://postgres:isolated-test-only@127.0.0.1:55434/demo_test_db",
    ADMIN_NAME: "Demo fixture admin",
    ADMIN_USERNAME: "demo-admin",
    ADMIN_PHONE: "01799900000",
    ADMIN_PASSWORD: "integration-demo-password",
    DEMO_MANAGER_PASSWORD: "49382716",
  };
  pool = new Pool({ connectionString: env.DATABASE_URL });
  await exec("scripts/migrate.mjs", env);
  assert.equal((await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n, 5);
  await exec("scripts/create-admin.mjs", env);
  await exec("scripts/seed-demo.mjs", env);
  const counts = (await pool.query(`
    SELECT (SELECT count(*)::int FROM houses) houses,
      (SELECT count(*)::int FROM rooms) rooms,
      (SELECT count(*)::int FROM users WHERE role='MANAGER') managers,
      (SELECT count(*)::int FROM users WHERE role='RESIDENT') residents,
      (SELECT count(*)::int FROM tenancies) tenancies,
      (SELECT count(*)::int FROM bills) bills,
      (SELECT count(*)::int FROM payments) payments,
      (SELECT count(*)::int FROM bill_segments) segments,
      (SELECT count(*)::int FROM audit_events WHERE action='demo.seeded') markers
  `)).rows[0];
  assert.deepEqual(counts, {
    houses: 3, rooms: 24, managers: 3, residents: 3,
    tenancies: 3, bills: 6, payments: 4, segments: 3, markers: 1,
  });
  const sums = (await pool.query(`
    SELECT type, sum(amount_minor)::text amount, sum(paid_minor)::text paid,
      count(*)::int count FROM bills GROUP BY type ORDER BY type
  `)).rows;
  assert.deepEqual(sums, [
    { type: "electricity", amount: "295000", paid: "135000", count: 3 },
    { type: "rent", amount: "3000000", paid: "1400000", count: 3 },
  ]);
  assert.equal((await pool.query("SELECT count(*)::int n FROM users WHERE role='MANAGER' AND password_hash IS NOT NULL AND nid IS NOT NULL")).rows[0].n, 3);
  await exec("scripts/create-admin.mjs", env);
  const rerun = await exec("scripts/seed-demo.mjs", env);
  assert.match(rerun, /already seeded/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM payments")).rows[0].n, 4);
  console.log("PASS: migrations, env admin bootstrap, PostgreSQL demo records, ledger sums and idempotent re-seeding");
} finally {
  if (pool) await pool.end();
  try { await pg.stop(); } catch {}
  await rm(dir, { recursive: true, force: true });
}
