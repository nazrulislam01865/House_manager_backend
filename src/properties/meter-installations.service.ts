import { Injectable, Inject, ConflictException } from "@nestjs/common";
import { Database } from "../database/database.service.js";
import { type Actor, audit, one } from "../common/context.js";
import { monthBoundary } from "../people/tenancy.service.js";
@Injectable()
export class MeterInstallationsService {
  constructor(@Inject(Database) private db: Database) {}
  async link(
    a: Actor,
    roomId: string,
    d: { serial: string; installedAt: string; baseline: string },
  ) {
    return this.db.tx(async (c) => {
      await one(
        c,
        "SELECT r.id FROM rooms r JOIN houses h ON h.id=r.house_id AND NOT h.archived WHERE r.id=$1 AND r.organization_id=$2 FOR UPDATE OF r",
        [roomId, a.organizationId],
      );
      const mi = await one(
        c,
        "INSERT INTO meter_installations(organization_id,room_id,serial,installed_at) VALUES($1,$2,$3,$4) RETURNING id",
        [a.organizationId, roomId, d.serial, d.installedAt],
      );
      await c.query(
        "INSERT INTO meter_readings(installation_id,read_at,reading,created_by) VALUES($1,$2,$3,$4)",
        [mi.id, d.installedAt, d.baseline, a.id],
      );
      await audit(c, a, "meter.linked", mi.id, { roomId, ...d });
      return mi;
    });
  }
  async replace(
    a: Actor,
    id: string,
    d: { serial: string; installedAt: string; baseline: string },
  ) {
    monthBoundary(d.installedAt);
    return this.db.tx(async (c) => {
      const mi = await one(
        c,
        "SELECT * FROM meter_installations WHERE id=$1 AND organization_id=$2 AND removed_at IS NULL FOR UPDATE",
        [id, a.organizationId],
      );
      if (d.installedAt <= String(mi.installed_at))
        throw new ConflictException("Replacement must follow installation");
      const settled = await c.query(
        "SELECT 1 FROM meter_readings mr JOIN bill_segments bs ON bs.current_reading_id=mr.id JOIN bills b ON b.id=bs.bill_id WHERE mr.installation_id=$1 AND mr.read_at=$2 AND mr.accepted AND b.lifecycle='ISSUED'",
        [id, d.installedAt],
      );
      if (!settled.rowCount)
        throw new ConflictException(
          "Issue the old meter final bill at the replacement boundary first",
        );
      await c.query(
        "UPDATE meter_installations SET removed_at=$1 WHERE id=$2",
        [d.installedAt, id],
      );
      const next = await one(
        c,
        "INSERT INTO meter_installations(organization_id,room_id,serial,installed_at) VALUES($1,$2,$3,$4) RETURNING id",
        [a.organizationId, mi.room_id, d.serial, d.installedAt],
      );
      await c.query(
        "INSERT INTO meter_readings(installation_id,read_at,reading,created_by) VALUES($1,$2,$3,$4)",
        [next.id, d.installedAt, d.baseline, a.id],
      );
      await audit(c, a, "meter.replaced", id, { replacementId: next.id, ...d });
      return next;
    });
  }
}
