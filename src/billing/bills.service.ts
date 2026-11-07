import { Injectable, Inject, ConflictException } from "@nestjs/common";
import { Database } from "../database/database.service.js";
import {
  type Actor,
  audit,
  one,
  checkVersion,
  outbox,
} from "../common/context.js";
import { type ListQuery } from "../common/validation.js";
import { paginate } from "../common/pagination.js";
import { z } from "zod";
import { Decimal } from "decimal.js";
import * as s from "./billing.schemas.js";
import { monthBoundary } from "../people/tenancy.service.js";
import { idempotent } from "./idempotency.js";
export const billSelect = `SELECT b.id,b.type,b.month,b.due_date AS "dueDate",b.amount_minor::text AS "amountMinor",b.paid_minor::text AS "paidMinor",(b.amount_minor-b.paid_minor)::text AS "remainingMinor",b.lifecycle,b.version,b.tenancy_id AS "tenancyId",b.room_id AS "roomId",r.number AS "roomNumber",u.name AS "residentName",b.house_id AS "houseId",h.name AS "houseName",mi.serial AS meter,bs.usage::text,bs.rate::text,pr.reading::text AS previous,cr.reading::text AS current FROM bills b JOIN rooms r ON r.id=b.room_id JOIN users u ON u.id=b.resident_id JOIN houses h ON h.id=b.house_id LEFT JOIN bill_segments bs ON bs.bill_id=b.id LEFT JOIN meter_installations mi ON mi.id=bs.installation_id LEFT JOIN meter_readings pr ON pr.id=bs.previous_reading_id LEFT JOIN meter_readings cr ON cr.id=bs.current_reading_id`;
@Injectable()
export class BillsService {
  constructor(@Inject(Database) private db: Database) {}
  list(a: Actor, type: "rent" | "electricity", q: ListQuery) {
    return paginate(
      this.db,
      billSelect +
        ` WHERE b.organization_id=$1 AND b.type=$2 AND b.lifecycle='ISSUED' AND ($3::uuid IS NULL OR b.house_id=$3) AND ($4::date IS NULL OR b.month=$4) AND ($5='All' OR ($5='Paid' AND b.amount_minor>0 AND b.paid_minor=b.amount_minor) OR ($5='Partial' AND b.paid_minor>0 AND b.paid_minor<b.amount_minor) OR ($5='Unpaid' AND b.paid_minor=0 AND b.amount_minor>0)) AND (u.name ILIKE $6 OR r.number ILIKE $6) ORDER BY b.created_at DESC,b.id DESC`,
      [
        a.organizationId,
        type,
        q.houseId || null,
        q.month ? q.month + "-01" : null,
        q.status || "All",
        "%" + q.search + "%",
      ],
      q,
    );
  }
  async detail(a: Actor, id: string) {
    return this.db.tx((c) =>
      one(c, billSelect + " WHERE b.organization_id=$1 AND b.id=$2", [
        a.organizationId,
        id,
      ]),
    );
  }
  async rentRun(
    a: Actor,
    d: z.infer<typeof s.rentRun>,
    key: string | undefined,
  ) {
    return this.db.tx((c) =>
      idempotent(c, a, "rent.run", key, d, async () => {
        await one(
          c,
          "SELECT id FROM houses WHERE id=$1 AND organization_id=$2 AND NOT archived FOR SHARE",
          [d.houseId, a.organizationId],
        );
        const month = d.month + "-01";
        const result = await c.query(
          `INSERT INTO bills(organization_id,tenancy_id,house_id,room_id,resident_id,type,month,due_date,amount_minor,scope_owner_id) SELECT t.organization_id,t.id,r.house_id,r.id,t.resident_id,'rent',$3::date,$3::date+($4::int-1),rt.amount_minor,t.created_by FROM tenancies t JOIN rooms r ON r.id=t.room_id JOIN rent_terms rt ON rt.tenancy_id=t.id AND rt.effective_from<=$3::date AND (rt.effective_to IS NULL OR rt.effective_to>=($3::date+interval '1 month')::date) WHERE t.organization_id=$1 AND r.house_id=$2 AND NOT t.cancelled AND t.start_date<=$3::date AND (t.end_date IS NULL OR t.end_date>=($3::date+interval '1 month')::date) AND NOT EXISTS(SELECT 1 FROM bills old WHERE old.tenancy_id=t.id AND old.type='rent' AND old.month=$3::date) ON CONFLICT(tenancy_id,type,month) WHERE lifecycle='ISSUED' DO NOTHING RETURNING id`,
          [a.organizationId, d.houseId, month, d.dueDay],
        );
        await audit(c, a, "rent.generated", d.houseId, {
          month: d.month,
          count: result.rowCount,
        });
        await outbox(c, a, "rent.generated", {
          houseId: d.houseId,
          month: d.month,
        });
        return { created: result.rowCount };
      }),
    );
  }
  async correct(
    a: Actor,
    id: string,
    d: z.infer<typeof s.correctionInput>,
    key: string | undefined,
  ) {
    return this.db.tx((c) =>
      idempotent(c, a, "bill.correct:" + id, key, d, async () => {
        const b = await one(
          c,
          "SELECT * FROM bills WHERE id=$1 AND organization_id=$2 FOR UPDATE",
          [id, a.organizationId],
        );
        checkVersion(b.version, d.version);
        if (b.lifecycle !== "ISSUED" || BigInt(b.paid_minor) !== 0n)
          throw new ConflictException(
            "Reverse payments before replacing an issued bill",
          );
        if (b.type === "electricity")
          return this.correctElectricity(c, a, b, d);
        if (!d.amountMinor)
          throw new ConflictException(
            "Supply amountMinor for a rent correction",
          );
        await c.query(
          "UPDATE bills SET lifecycle='VOID',version=version+1 WHERE id=$1",
          [id],
        );
        const next = await one(
          c,
          `INSERT INTO bills(organization_id,tenancy_id,house_id,room_id,resident_id,type,month,due_date,amount_minor,scope_owner_id,revision,replaces_id) SELECT organization_id,tenancy_id,house_id,room_id,resident_id,type,month,due_date,$2,scope_owner_id,revision+1,id FROM bills WHERE id=$1 RETURNING id`,
          [id, d.amountMinor],
        );
        await audit(c, a, "bill.corrected", id, {
          ...d,
          replacementId: next.id,
        });
        return next;
      }),
    );
  }
  async correctElectricity(
    c: import("../database/database.service.js").Transaction,
    a: Actor,
    b: { id: string; version: number },
    d: z.infer<typeof s.correctionInput>,
  ) {
    if (!d.current)
      throw new ConflictException("Supply the corrected cumulative reading");
    const seg = await one(
      c,
      "SELECT bs.*,pr.reading AS previous,cr.read_at AS date FROM bill_segments bs JOIN meter_readings pr ON pr.id=bs.previous_reading_id JOIN meter_readings cr ON cr.id=bs.current_reading_id WHERE bs.bill_id=$1",
      [b.id],
    );
    await one(c, "SELECT id FROM meter_installations WHERE id=$1 FOR UPDATE", [
      seg.installation_id,
    ]);
    if (
      (
        await c.query(
          "SELECT 1 FROM bill_segments bs JOIN bills b ON b.id=bs.bill_id WHERE bs.previous_reading_id=$1 AND b.lifecycle='ISSUED' LIMIT 1",
          [seg.current_reading_id],
        )
      ).rowCount
    )
      throw new ConflictException(
        "Later bills depend on this reading. Reconcile the later bills first",
      );
    const usage = new Decimal(d.current).minus(seg.previous);
    if (usage.isNegative())
      throw new ConflictException(
        "Corrected reading is lower than the baseline",
      );
    const amount = usage
      .times(seg.rate)
      .times(100)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .toFixed(0);
    await c.query(
      "UPDATE bills SET lifecycle='VOID',version=version+1 WHERE id=$1",
      [b.id],
    );
    await c.query("UPDATE meter_readings SET accepted=false WHERE id=$1", [
      seg.current_reading_id,
    ]);
    const reading = await one(
      c,
      "INSERT INTO meter_readings(installation_id,read_at,reading,created_by,supersedes_id) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [seg.installation_id, seg.date, d.current, a.id, seg.current_reading_id],
    );
    const next = await one(
      c,
      "INSERT INTO bills(organization_id,tenancy_id,house_id,room_id,resident_id,type,month,due_date,amount_minor,scope_owner_id,revision,replaces_id) SELECT organization_id,tenancy_id,house_id,room_id,resident_id,type,month,due_date,$2,scope_owner_id,revision+1,id FROM bills WHERE id=$1 RETURNING id",
      [b.id, amount],
    );
    await c.query(
      "INSERT INTO bill_segments(bill_id,installation_id,previous_reading_id,current_reading_id,usage,rate,tariff_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        next.id,
        seg.installation_id,
        seg.previous_reading_id,
        reading.id,
        usage.toFixed(3),
        seg.rate,
        seg.tariff_id,
      ],
    );
    await audit(c, a, "electricity.corrected", b.id, {
      reason: d.reason,
      previousCurrentReadingId: seg.current_reading_id,
      replacementId: next.id,
    });
    return next;
  }
  async void(a: Actor, id: string, d: z.infer<typeof s.voidInput>) {
    return this.db.tx(async (c) => {
      const b = await one(
        c,
        "SELECT * FROM bills WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [id, a.organizationId],
      );
      checkVersion(b.version, d.version);
      if (BigInt(b.paid_minor) > 0n)
        throw new ConflictException("Reverse payments before voiding a bill");
      if (b.type === "electricity") {
        const seg = await one(
          c,
          "SELECT * FROM bill_segments WHERE bill_id=$1",
          [id],
        );
        await one(
          c,
          "SELECT id FROM meter_installations WHERE id=$1 FOR UPDATE",
          [seg.installation_id],
        );
        if (
          (
            await c.query(
              "SELECT 1 FROM bill_segments s JOIN bills b ON b.id=s.bill_id WHERE s.previous_reading_id=$1 AND b.lifecycle='ISSUED' LIMIT 1",
              [seg.current_reading_id],
            )
          ).rowCount
        )
          throw new ConflictException("Later bills depend on this reading");
        await c.query("UPDATE meter_readings SET accepted=false WHERE id=$1", [
          seg.current_reading_id,
        ]);
      }
      await c.query(
        "UPDATE bills SET lifecycle='VOID',version=version+1 WHERE id=$1",
        [id],
      );
      await audit(c, a, "bill.voided", id, d);
      return { ok: true };
    });
  }
  async rates(a: Actor, q: ListQuery) {
    return paginate(
      this.db,
      `SELECT tv.id,tv.house_id AS "houseId",h.name AS "houseName",tv.effective_from AS "effectiveFrom",tv.rate::text FROM tariff_versions tv JOIN houses h ON h.id=tv.house_id WHERE tv.organization_id=$1 AND tv.scope_owner_id IS NULL AND ($2::uuid IS NULL OR tv.house_id=$2) ORDER BY tv.effective_from DESC,tv.id`,
      [a.organizationId, q.houseId || null],
      q,
    );
  }
  async rate(a: Actor, d: z.infer<typeof s.rateInput>) {
    monthBoundary(d.effectiveFrom);
    return this.db.tx(async (c) => {
      await one(
        c,
        "SELECT id FROM houses WHERE id=$1 AND organization_id=$2 AND NOT archived FOR SHARE",
        [d.houseId, a.organizationId],
      );
      const r = await one(
        c,
        "INSERT INTO tariff_versions(organization_id,house_id,effective_from,rate,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id",
        [a.organizationId, d.houseId, d.effectiveFrom, d.rate, a.id],
      );
      await audit(c, a, "tariff.created", r.id, d);
      return r;
    });
  }
}
