import { Injectable, Inject, ConflictException } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { Database, type Transaction } from "../database/database.service.js";
import { type Actor, audit, one, outbox } from "../common/context.js";
import { z } from "zod";
import * as s from "./billing.schemas.js";
import { idempotent } from "./idempotency.js";
@Injectable()
export class MeteringService {
  constructor(@Inject(Database) private db: Database) {}
  async baseline(a: Actor, d: z.infer<typeof s.baselineInput>) {
    return this.db.tx(async (c) => {
      const mi = await one(
        c,
        "SELECT * FROM meter_installations WHERE room_id=$1 AND organization_id=$2 AND removed_at IS NULL FOR UPDATE",
        [d.roomId, a.organizationId],
      );
      if (d.date < String(mi.installed_at))
        throw new ConflictException("Reading date precedes meter installation");
      if (
        (
          await c.query(
            "SELECT 1 FROM meter_readings WHERE installation_id=$1 LIMIT 1",
            [mi.id],
          )
        ).rowCount
      )
        throw new ConflictException("Baseline already exists");
      const r = await one(
        c,
        "INSERT INTO meter_readings(installation_id,read_at,reading,created_by) VALUES($1,$2,$3,$4) RETURNING id",
        [mi.id, d.date, d.reading, a.id],
      );
      await audit(c, a, "meter.baseline", r.id, d);
      return r;
    });
  }
  async calculate(
    c: Transaction,
    a: Actor,
    d: z.infer<typeof s.electricityInput>,
    lock = false,
  ) {
    const today = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "Asia/Dhaka",
    }).format(new Date());
    if (d.readAt > today)
      throw new ConflictException(
        "A meter reading cannot be dated in the future",
      );
    const room = await one(
      c,
      "SELECT r.* FROM rooms r JOIN houses h ON h.id=r.house_id AND NOT h.archived WHERE r.id=$1 AND r.organization_id=$2" +
        (lock ? " FOR UPDATE OF r" : ""),
      [d.roomId, a.organizationId],
    );
    const mi = await one(
      c,
      "SELECT * FROM meter_installations WHERE room_id=$1 AND removed_at IS NULL" +
        (lock ? " FOR UPDATE" : ""),
      [room.id],
    );
    const previous = await one(
      c,
      "SELECT * FROM meter_readings WHERE installation_id=$1 AND accepted ORDER BY read_at DESC LIMIT 1",
      [mi.id],
    );
    const t = await one(
      c,
      "SELECT * FROM tenancies WHERE room_id=$1 AND NOT cancelled AND start_date<=$2::date AND (end_date IS NULL OR end_date>=$3::date)",
      [room.id, d.month + "-01", d.readAt],
    );
    const tariff = await one(
      c,
      "SELECT * FROM tariff_versions WHERE house_id=$1 AND scope_owner_id IS NULL AND effective_from<=$2::date ORDER BY effective_from DESC LIMIT 1",
      [room.house_id, d.month + "-01"],
    );
    if (
      d.readAt <= String(previous.read_at) ||
      String(previous.read_at) < String(t.start_date)
    )
      throw new ConflictException(
        "Reading must follow the baseline and stay within this tenancy",
      );
    const max = new Date(d.month + "-01T00:00:00Z");
    max.setUTCMonth(max.getUTCMonth() + 1);
    if (d.readAt < d.month + "-01" || d.readAt > max.toISOString().slice(0, 10))
      throw new ConflictException(
        "Reading date must be in the bill month or its closing boundary",
      );
    if (new Decimal(d.current).lessThan(previous.reading))
      throw new ConflictException(
        "Reading cannot decrease. Use a reviewed meter replacement.",
      );
    if (
      (d.previousReadingId && d.previousReadingId !== previous.id) ||
      (d.tariffId && d.tariffId !== tariff.id)
    )
      throw new ConflictException("Preview is stale. Calculate again.");
    const usage = new Decimal(d.current).minus(previous.reading);
    const amountMinor = usage
      .times(tariff.rate)
      .times(100)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .toFixed(0);
    if (BigInt(amountMinor) > 1000000000000n)
      throw new ConflictException("Bill amount exceeds supported maximum");
    return {
      room,
      mi,
      previous,
      t,
      tariff,
      usage: usage.toFixed(3),
      amountMinor,
    };
  }
  async preview(a: Actor, d: z.infer<typeof s.electricityInput>) {
    return this.db.tx(async (c) => {
      const p = await this.calculate(c, a, d);
      return {
        roomId: p.room.id,
        previous: p.previous.reading,
        current: d.current,
        usage: p.usage,
        rate: p.tariff.rate,
        amountMinor: p.amountMinor,
        previousReadingId: p.previous.id,
        tariffId: p.tariff.id,
        meter: p.mi.serial,
      };
    });
  }
  async issue(
    a: Actor,
    d: z.infer<typeof s.electricityIssue>,
    key: string | undefined,
  ) {
    return this.db.tx((c) =>
      idempotent(c, a, "electricity.issue", key, d, async () => {
        const p = await this.calculate(c, a, d, true);
        const reading = await one(
          c,
          "INSERT INTO meter_readings(installation_id,read_at,reading,created_by) VALUES($1,$2,$3,$4) RETURNING id",
          [p.mi.id, d.readAt, d.current, a.id],
        );
        const bill = await one(
          c,
          "INSERT INTO bills(organization_id,tenancy_id,house_id,room_id,resident_id,type,month,due_date,amount_minor,scope_owner_id) VALUES($1,$2,$3,$4,$5,'electricity',$6,$7,$8,$9) RETURNING id",
          [
            a.organizationId,
            p.t.id,
            p.room.house_id,
            p.room.id,
            p.t.resident_id,
            d.month + "-01",
            d.readAt,
            p.amountMinor,
            p.t.created_by,
          ],
        );
        await c.query(
          "INSERT INTO bill_segments(bill_id,installation_id,previous_reading_id,current_reading_id,usage,rate,tariff_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            bill.id,
            p.mi.id,
            p.previous.id,
            reading.id,
            p.usage,
            p.tariff.rate,
            p.tariff.id,
          ],
        );
        await audit(c, a, "electricity.issued", bill.id, {
          readingId: reading.id,
          amountMinor: p.amountMinor,
        });
        await outbox(c, a, "bill.issued", { billId: bill.id });
        return bill;
      }),
    );
  }
  async readings(a: Actor, roomId: string) {
    return this.db.query(
      `SELECT mr.id,mr.read_at AS date,mr.reading::text,mi.serial AS meter FROM meter_readings mr JOIN meter_installations mi ON mi.id=mr.installation_id WHERE mi.organization_id=$1 AND mi.room_id=$2 ORDER BY mr.read_at DESC,mr.id DESC LIMIT 100`,
      [a.organizationId, roomId],
    );
  }
}
