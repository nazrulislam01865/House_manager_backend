import { Injectable, Inject, ConflictException } from "@nestjs/common";
import { Database, type Transaction } from "../database/database.service.js";
import { type Actor, audit, one } from "../common/context.js";
import { z } from "zod";
import * as s from "./people.schemas.js";
export function monthBoundary(date: string) {
  if (!date.endsWith("-01"))
    throw new ConflictException(
      "This release requires month-boundary occupancy and rent changes. Mid-month proration needs an approved policy.",
    );
}
@Injectable()
export class TenancyService {
  constructor(@Inject(Database) private db: Database) {}
  async allocate(
    c: Transaction,
    a: Actor,
    residentId: string,
    roomId: string,
    startDate: string,
    rentMinor: string,
  ) {
    monthBoundary(startDate);
    const room = await one(
      c,
      "SELECT r.* FROM rooms r JOIN houses h ON h.id=r.house_id AND NOT h.archived WHERE r.id=$1 AND r.organization_id=$2 FOR UPDATE OF r",
      [roomId, a.organizationId],
    );
    await one(
      c,
      "SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND role='RESIDENT' AND active FOR UPDATE",
      [residentId, a.organizationId],
    );
    const t = await one(
      c,
      "INSERT INTO tenancies(organization_id,room_id,resident_id,start_date,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id",
      [a.organizationId, room.id, residentId, startDate, a.id],
    );
    await c.query(
      "INSERT INTO rent_terms(tenancy_id,effective_from,amount_minor) VALUES($1,$2,$3)",
      [t.id, startDate, rentMinor],
    );
    return t;
  }
  async reallocate(a: Actor, d: z.infer<typeof s.allocationInput>) {
    return this.db.tx(async (c) => {
      const t = await this.allocate(
        c,
        a,
        d.residentId,
        d.roomId,
        d.startDate,
        d.rentMinor,
      );
      await audit(c, a, "tenancy.allocated", t.id, {
        residentId: d.residentId,
        roomId: d.roomId,
      });
      return t;
    });
  }
  async close(c: Transaction, a: Actor, id: string, endDate: string) {
    monthBoundary(endDate);
    const t = await one(
      c,
      "SELECT * FROM tenancies WHERE id=$1 AND organization_id=$2 AND end_date IS NULL AND NOT cancelled FOR UPDATE",
      [id, a.organizationId],
    );
    if (
      (
        await c.query(
          "SELECT 1 FROM bills WHERE tenancy_id=$1 AND lifecycle='ISSUED' AND month>=$2::date LIMIT 1",
          [id, endDate],
        )
      ).rowCount
    )
      throw new ConflictException(
        "Resolve bills at or after the requested end month before ending the tenancy",
      );
    if (endDate <= String(t.start_date))
      throw new ConflictException("End date must follow start date");
    const [meter] = (
      await c.query(
        "SELECT id FROM meter_installations WHERE room_id=$1 AND installed_at<$2 AND (removed_at IS NULL OR removed_at>=$2)",
        [t.room_id, endDate],
      )
    ).rows;
    if (meter) {
      const boundary = (
        await c.query(
          "SELECT 1 FROM meter_readings mr JOIN bill_segments bs ON bs.current_reading_id=mr.id JOIN bills b ON b.id=bs.bill_id WHERE mr.installation_id=$1 AND mr.read_at=$2 AND b.tenancy_id=$3 AND b.lifecycle='ISSUED'",
          [meter.id, endDate, id],
        )
      ).rowCount;
      if (!boundary)
        throw new ConflictException(
          "Issue the final electricity bill using an end-date reading before ending this tenancy",
        );
    }
    await c.query("UPDATE tenancies SET end_date=$1 WHERE id=$2", [
      endDate,
      id,
    ]);
    return t;
  }
  async end(a: Actor, id: string, d: z.infer<typeof s.endInput>) {
    return this.db.tx(async (c) => {
      await this.close(c, a, id, d.endDate);
      await audit(c, a, "tenancy.ended", id, d);
      return { ok: true };
    });
  }
  async move(a: Actor, id: string, d: z.infer<typeof s.moveInput>) {
    return this.db.tx(async (c) => {
      const original = await one(
        c,
        "SELECT * FROM tenancies WHERE organization_id=$1 AND id=$2",
        [a.organizationId, id],
      );
      await c.query(
        "SELECT id FROM rooms WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
        [[original.room_id, d.roomId]],
      );
      if (original.room_id === d.roomId)
        throw new ConflictException("Choose a different room");
      await this.close(c, a, id, d.effectiveDate);
      const next = await this.allocate(
        c,
        a,
        original.resident_id,
        d.roomId,
        d.effectiveDate,
        d.rentMinor,
      );
      await audit(c, a, "tenancy.moved", id, { ...d, newTenancyId: next.id });
      return next;
    });
  }
  async rentTerms(a: Actor, id: string, d: z.infer<typeof s.termsInput>) {
    monthBoundary(d.effectiveFrom);
    return this.db.tx(async (c) => {
      const t = await one(
        c,
        "SELECT * FROM tenancies WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [id, a.organizationId],
      );
      if (
        d.effectiveFrom < String(t.start_date) ||
        (t.end_date && d.effectiveFrom >= String(t.end_date))
      )
        throw new ConflictException("Effective date is outside tenancy");
      if (
        (
          await c.query(
            "SELECT 1 FROM bills WHERE tenancy_id=$1 AND type='rent' AND month>=$2 AND lifecycle='ISSUED' LIMIT 1",
            [id, d.effectiveFrom],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Issued bills exist. Use a later effective month or correct the bills explicitly.",
        );
      const terms = await one(
        c,
        "SELECT * FROM rent_terms WHERE tenancy_id=$1 AND effective_to IS NULL FOR UPDATE",
        [id],
      );
      if (d.effectiveFrom <= String(terms.effective_from))
        throw new ConflictException(
          "New terms must start after existing terms",
        );
      await c.query("UPDATE rent_terms SET effective_to=$1 WHERE id=$2", [
        d.effectiveFrom,
        terms.id,
      ]);
      await c.query(
        "INSERT INTO rent_terms(tenancy_id,effective_from,amount_minor) VALUES($1,$2,$3)",
        [id, d.effectiveFrom, d.amountMinor],
      );
      await audit(c, a, "rent.terms.changed", id, d);
      return { ok: true };
    });
  }
}
