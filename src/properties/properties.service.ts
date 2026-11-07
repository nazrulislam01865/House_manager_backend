import { Injectable, Inject, ConflictException } from "@nestjs/common";
import { Database, type Transaction } from "../database/database.service.js";
import { type Actor, audit, one, checkVersion } from "../common/context.js";
import { type ListQuery } from "../common/validation.js";
import { paginate, activeTenancy } from "../common/pagination.js";
import { z } from "zod";
import * as input from "./properties.schemas.js";
const houseSelect = `SELECT h.id,h.name,h.address,h.archived,h.version,COALESCE((SELECT json_agg(json_build_object('id',u.id,'name',u.name)) FROM manager_assignments ma JOIN users u ON u.id=ma.manager_id WHERE ma.house_id=h.id AND ma.valid_to IS NULL),'[]') AS managers,(SELECT count(*)::int FROM rooms r WHERE r.house_id=h.id) AS "roomCount",(SELECT count(*)::int FROM rooms r JOIN tenancies t ON t.room_id=r.id WHERE r.house_id=h.id AND ${activeTenancy}) AS occupied FROM houses h`;
@Injectable()
export class PropertiesService {
  constructor(@Inject(Database) private db: Database) {}
  list(a: Actor, q: ListQuery) {
    return paginate(
      this.db,
      houseSelect +
        ` WHERE h.organization_id=$1 AND NOT h.archived AND (h.name ILIKE $2 OR h.address ILIKE $2) ORDER BY h.created_at,h.id`,
      [a.organizationId, "%" + q.search + "%"],
      q,
    );
  }
  async detail(a: Actor, id: string) {
    return this.db.tx((c) =>
      one(c, houseSelect + " WHERE h.organization_id=$1 AND h.id=$2", [
        a.organizationId,
        id,
      ]),
    );
  }
  async assign(c: Transaction, a: Actor, houseId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    for (const id of unique) {
      const m = await one(
        c,
        "SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND role='MANAGER' AND active FOR SHARE",
        [id, a.organizationId],
      );
      if (!m) throw new ConflictException("Manager inactive");
    }
    await c.query(
      "UPDATE manager_assignments SET valid_to=now() WHERE house_id=$1 AND valid_to IS NULL AND NOT(manager_id=ANY($2::uuid[]))",
      [houseId, unique],
    );
    for (const id of unique)
      await c.query(
        "INSERT INTO manager_assignments(organization_id,house_id,manager_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [a.organizationId, houseId, id],
      );
  }
  async create(a: Actor, d: z.infer<typeof input.houseInput>) {
    return this.db.tx(async (c) => {
      const h = await one(
        c,
        "INSERT INTO houses(organization_id,name,address) VALUES($1,$2,$3) RETURNING id",
        [a.organizationId, d.name, d.address],
      );
      await this.assign(c, a, h.id, d.managerIds);
      await audit(c, a, "house.created", h.id);
      return h;
    });
  }
  async edit(a: Actor, id: string, d: z.infer<typeof input.houseEdit>) {
    return this.db.tx(async (c) => {
      const h = await one(
        c,
        "SELECT * FROM houses WHERE organization_id=$1 AND id=$2 FOR UPDATE",
        [a.organizationId, id],
      );
      checkVersion(h.version, d.version);
      if (h.archived) throw new ConflictException("House is archived");
      await c.query(
        "UPDATE houses SET name=$1,address=$2,version=version+1 WHERE id=$3",
        [d.name, d.address, id],
      );
      await this.assign(c, a, id, d.managerIds);
      await audit(c, a, "house.updated", id);
      return { id };
    });
  }
  async changeAssignments(
    a: Actor,
    id: string,
    d: z.infer<typeof input.assignmentInput>,
  ) {
    const h = await this.detail(a, id);
    return this.edit(a, id, {
      name: h.name,
      address: h.address,
      managerIds: d.managerIds,
      version: d.version,
    });
  }
  async remove(a: Actor, id: string, v: number, archive: boolean) {
    return this.db.tx(async (c) => {
      const h = await one(
        c,
        "SELECT * FROM houses WHERE organization_id=$1 AND id=$2 FOR UPDATE",
        [a.organizationId, id],
      );
      checkVersion(h.version, v);
      if (archive) {
        const [active] = (
          await c.query(
            `SELECT 1 FROM tenancies t JOIN rooms r ON r.id=t.room_id WHERE r.house_id=$1 AND NOT t.cancelled AND (t.end_date IS NULL OR t.end_date>(now() AT TIME ZONE 'Asia/Dhaka')::date) LIMIT 1`,
            [id],
          )
        ).rows;
        if (active)
          throw new ConflictException(
            "End all active and scheduled tenancies before archiving",
          );
        await c.query(
          "UPDATE houses SET archived=true,version=version+1 WHERE id=$1",
          [id],
        );
      } else {
        if (
          (await c.query("SELECT 1 FROM rooms WHERE house_id=$1 LIMIT 1", [id]))
            .rowCount
        )
          throw new ConflictException(
            "Delete unused rooms first, or archive this house",
          );
        await c.query("DELETE FROM manager_assignments WHERE house_id=$1", [
          id,
        ]);
        await c.query("DELETE FROM houses WHERE id=$1", [id]);
      }
      await audit(c, a, archive ? "house.archived" : "house.deleted", id);
      return { ok: true };
    });
  }
  rooms(a: Actor, q: ListQuery) {
    return paginate(
      this.db,
      `SELECT r.id,r.house_id AS "houseId",h.name AS "houseName",r.number,r.rent_minor::text AS "rentMinor",r.version,t.id AS "tenancyId",u.id AS "residentId",u.name AS "residentName",mi.serial AS meter,mi.id AS "installationId" FROM rooms r JOIN houses h ON h.id=r.house_id LEFT JOIN tenancies t ON t.room_id=r.id AND ${activeTenancy} LEFT JOIN users u ON u.id=t.resident_id LEFT JOIN meter_installations mi ON mi.room_id=r.id AND mi.removed_at IS NULL WHERE r.organization_id=$1 AND ($2::uuid IS NULL OR r.house_id=$2) AND NOT h.archived AND r.number ILIKE $3 ORDER BY r.number,r.id`,
      [a.organizationId, q.houseId || null, "%" + q.search + "%"],
      q,
    );
  }
  async addRoom(a: Actor, d: z.infer<typeof input.roomInput>) {
    return this.db.tx(async (c) => {
      const h = await one(
        c,
        "SELECT id,archived FROM houses WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [d.houseId, a.organizationId],
      );
      if (h.archived) throw new ConflictException("House is archived");
      const r = await one(
        c,
        "INSERT INTO rooms(organization_id,house_id,number,rent_minor,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id",
        [a.organizationId, d.houseId, d.number, d.rentMinor, a.id],
      );
      if (d.meter)
        await c.query(
          "INSERT INTO meter_installations(organization_id,room_id,serial,installed_at) VALUES($1,$2,$3,$4)",
          [
            a.organizationId,
            r.id,
            d.meter,
            d.installedAt || new Date().toISOString().slice(0, 10),
          ],
        );
      await audit(c, a, "room.created", r.id);
      return r;
    });
  }
  async editRoom(a: Actor, id: string, d: z.infer<typeof input.roomEdit>) {
    return this.db.tx(async (c) => {
      const r = await one(
        c,
        "SELECT r.* FROM rooms r JOIN houses h ON h.id=r.house_id AND NOT h.archived WHERE r.id=$1 AND r.organization_id=$2 FOR UPDATE OF r",
        [id, a.organizationId],
      );
      checkVersion(r.version, d.version);
      await c.query(
        "UPDATE rooms SET number=$1,rent_minor=$2,version=version+1 WHERE id=$3",
        [d.number, d.rentMinor, id],
      );
      await audit(c, a, "room.updated", id, {
        before: { number: r.number, rentMinor: r.rent_minor },
        after: d,
      });
      return { id };
    });
  }
  async deleteRoom(a: Actor, id: string, v: number) {
    return this.db.tx(async (c) => {
      const r = await one(
        c,
        "SELECT * FROM rooms WHERE id=$1 AND organization_id=$2 FOR UPDATE",
        [id, a.organizationId],
      );
      checkVersion(r.version, v);
      if (
        (
          await c.query(
            "SELECT 1 FROM tenancies WHERE room_id=$1 UNION ALL SELECT 1 FROM meter_installations WHERE room_id=$1 LIMIT 1",
            [id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "Room has tenancy or meter history and cannot be deleted",
        );
      await c.query("DELETE FROM rooms WHERE id=$1", [id]);
      await audit(c, a, "room.deleted", id);
      return { ok: true };
    });
  }
}
