import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, appendFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool, types } from "pg";
import { hash } from "argon2";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
const dir = await mkdtemp(join(tmpdir(), "houseledger-integration-"));
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: "postgres",
  password: "isolated-test-only",
  port: 55433,
  persistent: false,
  autoRehydrateSymlinks: true,
  onLog: () => {},
  onError: () => {},
});
let app, pool, frontend;
let passed = 0;
try {
  await pg.initialise();
  await appendFile(
    join(dir, "postgresql.conf"),
    "\nunix_socket_directories = ''\n",
  );
  await pg.start();
  await pg.createDatabase("test_db");
  process.env.NODE_ENV = "test";
  process.env.OBSERVE_APP_KEY = "";
  process.env.OBSERVE_APP_SECRET = "";
  process.env.DATABASE_URL =
    "postgres://postgres:isolated-test-only@127.0.0.1:55433/test_db";
  process.env.FRONTEND_ORIGINS = "http://localhost:3000";
  types.setTypeParser(1082, (v) => v);
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (let pass = 0; pass < 2; pass++)
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/migrate.mjs"], {
        env: process.env,
        stdio: "pipe",
      });
      let error = "";
      child.stderr.on("data", (chunk) => (error += chunk));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(error)),
      );
    });
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM schema_migrations")).rows[0]
      .n,
    5,
  );
  passed++;
  const org = (
    await pool.query(
      "INSERT INTO organizations(name) VALUES('Integration test organization') RETURNING id",
    )
  ).rows[0].id;
  const admin = (
    await pool.query(
      "INSERT INTO users(organization_id,role,name,username,phone,password_hash) VALUES($1,'ADMIN','Test administrator','testadmin','+8801711111111',$2) RETURNING id",
      [org, await hash("test-only-password-strong")],
    )
  ).rows[0].id;
  const { createApp } = await import("../dist/main.js");
  app = await createApp();
  await app.listen(process.env.RUN_FRONTEND ? 4000 : 0, "127.0.0.1");
  const base = (await app.getUrl()) + "/api/v1";
  let cookie = "",
    csrf = "";
  async function request(path, method = "GET", body, key) {
    const r = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await r.json();
    return {
      status: r.status,
      body: json,
      cookie: r.headers.get("set-cookie"),
    };
  }
  const ok = (r, status = 201) => {
    assert.equal(r.status, status, JSON.stringify(r.body));
    passed++;
    return r.body;
  };
  assert.equal((await request("/houses")).status, 401);
  passed++;
  const login = await request("/auth/web/login", "POST", {
    phone: "01711111111",
    password: "test-only-password-strong",
  });
  const l = ok(login);
  cookie = login.cookie.split(";")[0];
  csrf = l.csrf;
  const usernameLogin = ok(await request("/auth/web/login", "POST", {
    identifier: "testadmin", password: "test-only-password-strong"
  }));
  assert.equal(usernameLogin.user.role, "ADMIN");
  passed++;
  let dashboard = ok(await request("/dashboard?month=2026-11"), 200);
  assert.equal(dashboard.houses, 0);
  assert.equal(dashboard.rent.amountMinor, "0");
  passed++;
  const manager = ok(
    await request("/managers", "POST", {
      name: "Test manager",
      phone: "01722222222",
      nid: "0000000123",
      password: "49382716",
    }),
  );
  const account = (await pool.query("SELECT nid,password_hash FROM users WHERE id=$1", [manager.id])).rows[0];
  assert.equal(account.nid, "0000000123");
  assert.notEqual(account.password_hash, "49382716");
  passed++;
  assert.equal((await request("/managers", "POST", {
    name: "Missing NID", phone: "01722222223", password: "long-enough-password"
  })).status, 400);
  passed++;
  assert.equal((await request("/managers", "POST", {
    name: "Invalid manager PIN", phone: "01722222224", nid: "0000000124",
    password: "abcdefgh"
  })).status, 400);
  passed++;
  for (const password of ["1234567", "123456789"]) {
    assert.equal((await request("/managers", "POST", {
      name: "Invalid manager PIN", phone: "01722222225", nid: "0000000125", password
    })).status, 400);
  }
  passed++;
  const appLogin = ok(await request("/auth/app/login", "POST", {
    phone: "01722222222", password: "49382716"
  }));
  assert.equal(appLogin.user.role, "MANAGER");
  const appMeBefore = await fetch(base + "/auth/app/me", {
    headers: { Authorization: "Bearer " + appLogin.token }
  }).then(r => r.json());
  assert.deepEqual(appMeBefore.houses, []);
  const appAdminDenied = await fetch(base + "/houses", {
    headers: { Authorization: "Bearer " + appLogin.token }
  });
  assert.equal(appAdminDenied.status, 401);
  passed++;
  const house = ok(
    await request("/houses", "POST", {
      name: "Test property",
      address: "Test address",
      managerIds: [manager.id],
    }),
  );
  const appMeAfter = await fetch(base + "/auth/app/me", {
    headers: { Authorization: "Bearer " + appLogin.token }
  }).then(r => r.json());
  assert.equal(appMeAfter.houses.length, 1);
  assert.equal(appMeAfter.houses[0].id, house.id);
  passed++;
  const room = ok(
    await request("/rooms", "POST", {
      houseId: house.id,
      number: "101",
      rentMinor: "1000000",
      meter: "INTEGRATION-METER",
      installedAt: "2026-10-01",
    }),
  );
  const resident = ok(
    await request("/residents", "POST", {
      name: "Test resident",
      phone: "01733333333",
      roomId: room.id,
      startDate: "2026-10-01",
      rentMinor: "1000000",
    }),
  );
  assert.equal(
    (
      await request("/residents", "POST", {
        name: "Conflict resident",
        phone: "01744444444",
        roomId: room.id,
        startDate: "2026-11-01",
        rentMinor: "1000000",
      })
    ).status,
    409,
  );
  passed++;
  const run = { houseId: house.id, month: "2026-11", dueDay: 5 },
    runKey = randomUUID();
  ok(await request("/rent/bill-runs", "POST", run, runKey));
  ok(await request("/rent/bill-runs", "POST", run, runKey));
  const rentList = ok(await request("/rent/bills?month=2026-11"), 200);
  assert.equal(rentList.data.length, 1);
  passed++;
  const bill = rentList.data[0];
  assert.equal(
    (
      await request("/rent/bills/" + bill.id + "/payments", "POST", {
        amountMinor: "1",
        method: "Cash",
        receivedAt: "2026-11-07",
      })
    ).status,
    400,
  );
  passed++;
  assert.equal(
    (
      await request(
        "/electricity/bills/" + bill.id + "/payments",
        "POST",
        { amountMinor: "1", method: "Cash", receivedAt: "2026-11-07" },
        randomUUID(),
      )
    ).status,
    404,
  );
  passed++;
  const payload = {
      amountMinor: "600000",
      method: "Cash",
      receivedAt: "2026-11-07",
    },
    key = randomUUID();
  const pair = await Promise.all([
    request("/rent/bills/" + bill.id + "/payments", "POST", payload, key),
    request("/rent/bills/" + bill.id + "/payments", "POST", payload, key),
  ]);
  const p1 = ok(pair[0]),
    p2 = ok(pair[1]);
  assert.equal(p1.id, p2.id);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM payments WHERE bill_id=$1",
        [bill.id],
      )
    ).rows[0].n,
    1,
  );
  passed++;
  assert.equal(
    (
      await request(
        "/rent/bills/" + bill.id + "/payments",
        "POST",
        { ...payload, amountMinor: "1" },
        key,
      )
    ).status,
    409,
  );
  passed++;
  const concurrent = await Promise.all([
    request(
      "/rent/bills/" + bill.id + "/payments",
      "POST",
      { ...payload, amountMinor: "300000" },
      randomUUID(),
    ),
    request(
      "/rent/bills/" + bill.id + "/payments",
      "POST",
      { ...payload, amountMinor: "300000" },
      randomUUID(),
    ),
  ]);
  assert.deepEqual(concurrent.map((x) => x.status).sort(), [201, 409]);
  passed++;
  const reverseKey = randomUUID();
  ok(
    await request(
      "/payments/" + p1.id + "/reversal",
      "POST",
      { reason: "Test correction" },
      reverseKey,
    ),
  );
  ok(
    await request(
      "/payments/" + p1.id + "/reversal",
      "POST",
      { reason: "Test correction" },
      reverseKey,
    ),
  );
  assert.equal(
    (
      await request(
        "/payments/" + p1.id + "/reversal",
        "POST",
        { reason: "Second reversal" },
        randomUUID(),
      )
    ).status,
    409,
  );
  passed++;
  ok(
    await request("/tariffs", "POST", {
      houseId: house.id,
      effectiveFrom: "2026-10-01",
      rate: "10",
    }),
  );
  ok(
    await request("/meter-readings/baseline", "POST", {
      roomId: room.id,
      date: "2026-10-01",
      reading: "2450",
    }),
  );
  const reading = {
    roomId: room.id,
    month: "2026-10",
    readAt: "2026-11-01",
    current: "2570",
  };
  const preview = ok(await request("/electricity/previews", "POST", reading));
  assert.equal(preview.amountMinor, "120000");
  passed++;
  const issue = {
    ...reading,
    previousReadingId: preview.previousReadingId,
    tariffId: preview.tariffId,
  };
  const e = ok(
    await request("/electricity/bills", "POST", issue, randomUUID()),
  );
  ok(
    await request("/tariffs", "POST", {
      houseId: house.id,
      effectiveFrom: "2026-11-01",
      rate: "12",
    }),
  );
  const existing = ok(await request("/bills/" + e.id), 200);
  assert.equal(existing.rate, "10.0000");
  assert.equal(existing.amountMinor, "120000");
  passed++;
  const corrected = ok(
    await request(
      "/bills/" + e.id + "/corrections",
      "POST",
      {
        version: existing.version,
        current: "2571",
        reason: "Verified reading correction",
      },
      randomUUID(),
    ),
  );
  assert.equal(
    (await request("/bills/" + corrected.id)).body.amountMinor,
    "121000",
  );
  passed++;
  const report = ok(await request("/dashboard?month=2026-11"), 200);
  assert.equal(report.rent.amountMinor, "1000000");
  assert.equal(report.rent.paidMinor, "300000");
  assert.equal(report.occupied, 1);
  passed++;
  assert.equal(
    (
      await request("/houses/" + house.id, "PATCH", {
        name: "Bad change",
        address: "Test",
        managerIds: [],
        version: 999,
      })
    ).status,
    409,
  );
  passed++;
  assert.equal(
    (await request("/houses/" + house.id, "DELETE", { version: 1 })).status,
    409,
  );
  passed++;
  const other = (
    await pool.query(
      "INSERT INTO organizations(name) VALUES('Other organization') RETURNING id",
    )
  ).rows[0].id;
  const otherHouse = (
    await pool.query(
      "INSERT INTO houses(organization_id,name,address) VALUES($1,'Other house','Private') RETURNING id",
      [other],
    )
  ).rows[0].id;
  assert.equal((await request("/houses/" + otherHouse)).status, 404);
  passed++;
  const noCsrf = await fetch(base + "/houses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ name: "Unauthorized write", address: "Test" }),
  });
  assert.equal(noCsrf.status, 403);
  passed++;
  assert.equal(
    (
      await request("/houses", "POST", {
        name: "Invalid role input",
        address: "Test",
        role: "ADMIN",
      })
    ).status,
    400,
  );
  passed++;
  const orgPayments = await pool.query(
    "SELECT sum(CASE WHEN kind='PAYMENT' THEN amount_minor ELSE -amount_minor END)::text n FROM payments WHERE bill_id=$1",
    [bill.id],
  );
  assert.equal(orgPayments.rows[0].n, "300000");
  passed++;
  await assert.rejects(pool.query("DELETE FROM payments WHERE id=$1", [p1.id]));
  passed++;
  const worker = spawn(process.execPath, ["dist/worker.js"], {
    env: process.env,
    stdio: "ignore",
  });
  try {
    let processed = 0;
    for (let i = 0; i < 40; i++) {
      processed = (
        await pool.query("SELECT count(*)::int n FROM processed_events")
      ).rows[0].n;
      if (processed > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(processed > 0, "Worker did not process committed outbox events");
    passed++;
  } finally {
    worker.kill("SIGTERM");
  }
  const emptyHouse = ok(
    await request("/houses", "POST", {
      name: "Empty test house",
      address: "Test address",
      managerIds: [],
    }),
  );
  ok(await request("/houses/" + emptyHouse.id, "DELETE", { version: 1 }), 200);
  assert.equal(
    (
      await request("/tenancies/" + resident.tenancyId + "/end", "POST", {
        endDate: "2026-11-01",
        reason: "Invalid historical end",
      })
    ).status,
    409,
  );
  passed++;
  assert.equal(
    (
      await request("/residents/" + resident.id, "PATCH", {
        name: "Test resident",
        phone: "01733333333",
        version: 1,
        active: false,
      })
    ).status,
    409,
  );
  passed++;
  const nextRoom = ok(
    await request("/rooms", "POST", {
      houseId: house.id,
      number: "102",
      rentMinor: "1000000",
    }),
  );
  const reallocation = await request("/tenancies", "POST", {
    residentId: resident.id,
    roomId: nextRoom.id,
    startDate: "2026-11-01",
    rentMinor: "1000000",
  });
  assert.equal(reallocation.status, 409);
  passed++;
  // The failed allocation must not create another tenancy.
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM tenancies WHERE resident_id=$1",
        [resident.id],
      )
    ).rows[0].n,
    1,
  );
  passed++;
  const schema = await fetch((await app.getUrl()) + "/api/docs-json").then(
    (r) => r.json(),
  );
  assert.ok(schema.paths["/api/v1/rent/bills/{id}/payments"].post.requestBody);
  passed++;
  if (process.env.RUN_FRONTEND) {
    const manifest = JSON.parse(
      await readFile(
        new URL("../../frontend/.next/routes-manifest.json", import.meta.url),
        "utf8",
      ),
    );
    const rewrites = Array.isArray(manifest.rewrites)
      ? manifest.rewrites
      : Object.values(manifest.rewrites).flat();
    assert.equal(
      rewrites.find((r) => r.source === "/api/v1/:path*")?.destination,
      "http://127.0.0.1:4000/api/v1/:path*",
      "Build the test frontend with API_ORIGIN=http://127.0.0.1:4000; remote API targets are never tested",
    );
    frontend = spawn(
      process.execPath,
      [
        "node_modules/next/dist/bin/next",
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        "4100",
      ],
      { cwd: new URL("../../frontend/", import.meta.url), stdio: "ignore" },
    );
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch("http://127.0.0.1:4100/");
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(ready, "Next.js production server did not start");
    const proxied = await fetch(
      "http://127.0.0.1:4100/api/v1/dashboard?month=2026-11",
      { headers: { Cookie: cookie } },
    );
    assert.equal(proxied.status, 200);
    const actual = await proxied.json();
    assert.equal(actual.rent.paidMinor, "300000");
    assert.equal(actual.rooms, 2);
    passed++;
    const proxyLogin = await fetch(
      "http://127.0.0.1:4100/api/v1/auth/web/login",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          phone: "01711111111",
          password: "test-only-password-strong",
        }),
      },
    );
    assert.equal(proxyLogin.status, 201);
    assert.match(proxyLogin.headers.get("set-cookie"), /hl_session=/);
    passed++;
    console.log(
      "NEXTJS_PROXY_PASSED: live database reads, authenticated cookie forwarding and login Set-Cookie forwarding",
    );
  }
  console.log(
    "INTEGRATION PASSED:",
    passed,
    "checks against real PostgreSQL; no production/demo business seed.",
  );
} finally {
  if (frontend) frontend.kill("SIGTERM");
  if (app) await app.close();
  if (pool) await pool.end();
  await pg.stop();
  await rm(dir, { recursive: true, force: true });
}
