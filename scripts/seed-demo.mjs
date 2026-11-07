/**
 * Explicit, repeat-safe local development reference data.
 * Refuses production and never truncates or replaces user-generated records.
 * Only 3 sample tenancies/6 sample bills are known; do not fake UI aggregates.
 */
import "dotenv/config";
import { Pool } from "pg";
import { hash } from "argon2";

if (process.env.NODE_ENV === "production")
  throw Error("Demo data seeding is disabled in production");
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required");
if (!process.env.ADMIN_PHONE) throw Error("ADMIN_PHONE is required to select the right admin workspace");
const adminPhone = process.env.ADMIN_PHONE.startsWith("0")
  ? "+88" + process.env.ADMIN_PHONE
  : process.env.ADMIN_PHONE;
const demoPassword = process.env.DEMO_MANAGER_PASSWORD || "";
if (demoPassword && !/^\d{8}$/.test(demoPassword))
  throw Error("DEMO_MANAGER_PASSWORD must contain exactly 8 numeric digits");
// The following are fictitious development-only example identities.
const managers = [
  { name: "Rahim Ahmed", phone: "+8801999999901", nid: "0000000101" },
  { name: "Mina Akter", phone: "+8801999999902", nid: "0000000102" },
  { name: "Karim Ali", phone: "+8801999999903", nid: "0000000103" },
];
const houses = [
  { code: "lakeview", name: "Lakeview House", address: "Mirpur, Dhaka" },
  { code: "garden", name: "Garden House", address: "Uttara, Dhaka" },
  { code: "riverside", name: "Riverside House", address: "Dhanmondi, Dhaka" },
];
const residents = [
  { name: "Ayesha Rahman", phone: "+8801711000001", house: "lakeview", room: "201", moveIn: "2026-11-01" },
  { name: "Hasan Khan", phone: "+8801711000002", house: "lakeview", room: "202", moveIn: "2026-11-01" },
  { name: "Mina Begum", phone: "+8801711000003", house: "lakeview", room: "204", moveIn: "2026-10-01" },
];
const bills = [
  { type: "rent", resident: 0, amount: 10000, paid: 4000 },
  { type: "rent", resident: 1, amount: 10000, paid: 0 },
  { type: "rent", resident: 2, amount: 10000, paid: 10000 },
  { type: "electricity", resident: 0, amount: 1200, paid: 0, previous: 2450, current: 2570 },
  { type: "electricity", resident: 1, amount: 950, paid: 950, previous: 2100, current: 2195 },
  { type: "electricity", resident: 2, amount: 800, paid: 400, previous: 1800, current: 1880 },
];
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const c = await pool.connect();
try {
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(673108926)");
  const admin = (
    await c.query(
      "SELECT id,organization_id FROM users WHERE role='ADMIN' AND active AND phone=$1",
      [adminPhone],
    )
  ).rows[0];
  if (!admin) throw Error("Matching admin not found. Run npm run admin:seed first.");
  const org = admin.organization_id;
  const marker = await c.query(
    "SELECT 1 FROM audit_events WHERE organization_id=$1 AND action='demo.seeded' LIMIT 1",
    [org],
  );
  if (marker.rowCount) {
    console.log("Reference records already seeded in this workspace; no changes made.");
    await c.query("COMMIT");
  } else {
    const existing = await c.query(
      `SELECT (SELECT count(*) FROM houses WHERE organization_id=$1) AS houses,
        (SELECT count(*) FROM users WHERE organization_id=$1 AND role<>'ADMIN') AS people,
        (SELECT count(*) FROM bills WHERE organization_id=$1) AS bills`,
      [org],
    );
    const checks = existing.rows[0];
    if (Number(checks.houses) || Number(checks.people) || Number(checks.bills))
      throw Error("Workspace already contains business data. Demo seeding refused to avoid mixing records.");
    const passwordHash = demoPassword ? await hash(demoPassword) : null;
    const managerIds = [];
    for (const m of managers) {
      const row = await c.query(
        `INSERT INTO users(organization_id,role,name,phone,nid,password_hash,created_by)
         VALUES($1,'MANAGER',$2,$3,$4,$5,$6) RETURNING id`,
        [org, m.name, m.phone, m.nid, passwordHash, admin.id],
      );
      managerIds.push(row.rows[0].id);
    }
    const houseIds = {};
    const roomIds = {};
    const meterIds = {};
    for (const [i, h] of houses.entries()) {
      const house = await c.query(
        "INSERT INTO houses(organization_id,name,address) VALUES($1,$2,$3) RETURNING id",
        [org, h.name, h.address],
      );
      houseIds[h.code] = house.rows[0].id;
      await c.query(
        "INSERT INTO manager_assignments(organization_id,house_id,manager_id) VALUES($1,$2,$3)",
        [org, house.rows[0].id, managerIds[i]],
      );
      // Demo tariffs effective for the example billing month.
      await c.query(
        `INSERT INTO tariff_versions(organization_id,house_id,effective_from,rate,created_by)
         VALUES($1,$2,'2026-11-01',10,$3)`,
        [org, house.rows[0].id, admin.id],
      );
      for (let n = 201; n <= 208; n++) {
        const room = await c.query(
          `INSERT INTO rooms(organization_id,house_id,number,rent_minor,created_by)
           VALUES($1,$2,$3,1000000,$4) RETURNING id`,
          [org, house.rows[0].id, String(n), admin.id],
        );
        const k = h.code + ":" + n;
        roomIds[k] = room.rows[0].id;
        if (h.code === "lakeview" && n === 203) continue;
        const meter = await c.query(
          `INSERT INTO meter_installations(organization_id,room_id,serial,installed_at)
           VALUES($1,$2,$3,'2026-10-01') RETURNING id`,
          [org, room.rows[0].id, `MTR-${i ? i : ""}0${n}`],
        );
        meterIds[k] = meter.rows[0].id;
      }
    }
    const tenancyIds = [];
    for (const r of residents) {
      const user = await c.query(
        `INSERT INTO users(organization_id,role,name,phone,created_by)
         VALUES($1,'RESIDENT',$2,$3,$4) RETURNING id`,
        [org, r.name, r.phone, admin.id],
      );
      const roomId = roomIds[r.house + ":" + r.room];
      const tenancy = await c.query(
        `INSERT INTO tenancies(organization_id,room_id,resident_id,start_date,created_by)
         VALUES($1,$2,$3,$4,$5) RETURNING id`,
        [org, roomId, user.rows[0].id, r.moveIn, admin.id],
      );
      await c.query(
        `INSERT INTO rent_terms(tenancy_id,effective_from,amount_minor)
         VALUES($1,$2,1000000)`,
        [tenancy.rows[0].id, r.moveIn],
      );
      tenancyIds.push({
        tenancyId: tenancy.rows[0].id,
        residentId: user.rows[0].id,
        roomId,
        houseId: houseIds[r.house],
        installationId: meterIds[r.house + ":" + r.room],
      });
    }
    for (const b of bills) {
      const ref = tenancyIds[b.resident];
      const bill = await c.query(
        `INSERT INTO bills(organization_id,tenancy_id,house_id,room_id,resident_id,type,month,due_date,amount_minor,paid_minor,scope_owner_id)
         VALUES($1,$2,$3,$4,$5,$6,'2026-11-01','2026-11-10',$7,$8,$9) RETURNING id`,
        [org, ref.tenancyId, ref.houseId, ref.roomId, ref.residentId, b.type, b.amount * 100, b.paid * 100, admin.id],
      );
      if (b.type === "electricity") {
        const prev = await c.query(
          "INSERT INTO meter_readings(installation_id,read_at,reading,created_by) VALUES($1,'2026-10-31',$2,$3) RETURNING id",
          [ref.installationId, b.previous, admin.id],
        );
        const current = await c.query(
          "INSERT INTO meter_readings(installation_id,read_at,reading,created_by) VALUES($1,'2026-11-07',$2,$3) RETURNING id",
          [ref.installationId, b.current, admin.id],
        );
        const tariff = await c.query(
          "SELECT id FROM tariff_versions WHERE house_id=$1 AND effective_from='2026-11-01'",
          [ref.houseId],
        );
        await c.query(
          `INSERT INTO bill_segments(bill_id,installation_id,previous_reading_id,current_reading_id,usage,rate,tariff_id)
           VALUES($1,$2,$3,$4,$5,10,$6)`,
          [bill.rows[0].id, ref.installationId, prev.rows[0].id, current.rows[0].id, b.current - b.previous, tariff.rows[0].id],
        );
      }
      if (b.paid > 0)
        await c.query(
          `INSERT INTO payments(organization_id,bill_id,kind,amount_minor,method,received_at,actor_id)
           VALUES($1,$2,'PAYMENT',$3,'Cash','2026-11-07',$4)`,
          [org, bill.rows[0].id, b.paid * 100, admin.id],
        );
    }
    await c.query(
      `INSERT INTO audit_events(organization_id,actor_id,action,detail)
       VALUES($1,$2,'demo.seeded',$3::jsonb)`,
      [org, admin.id, JSON.stringify({ referenceMonth: "2026-11", houses: 3, rooms: 24, residents: 3, bills: 6 })],
    );
    await c.query("COMMIT");
    console.log("Seeded 3 houses, 24 rooms, 3 managers, 3 residents, 6 bills and 4 payments in PostgreSQL.");
    console.log("Only known reference bills are included. Dashboard totals are derived from the ledger, not hardcoded reference totals.");
  }
} catch (error) {
  await c.query("ROLLBACK");
  throw error;
} finally {
  c.release();
  await pool.end();
}
