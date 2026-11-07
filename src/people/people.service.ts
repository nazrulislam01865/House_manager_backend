import { Injectable, Inject, ConflictException } from "@nestjs/common";
import { Database } from "../database/database.service.js";
import { type Actor, audit, one, checkVersion } from "../common/context.js";
import { type ListQuery } from "../common/validation.js";
import { paginate, activeTenancy } from "../common/pagination.js";
import { TenancyService } from "./tenancy.service.js";
import { z } from "zod";
import * as s from "./people.schemas.js";
import { hash } from "argon2";
@Injectable()
export class PeopleService {
  constructor(
    @Inject(Database) private db: Database,
    @Inject(TenancyService) private tenancies: TenancyService,
  ) {}
  managers(a: Actor, q: ListQuery) {
    return paginate(
      this.db,
      `SELECT u.id,u.name,u.phone,u.nid,u.active,u.version,COALESCE((SELECT json_agg(json_build_object('id',h.id,'name',h.name)) FROM manager_assignments ma JOIN houses h ON h.id=ma.house_id WHERE ma.manager_id=u.id AND ma.valid_to IS NULL),'[]') AS houses FROM users u WHERE u.organization_id=$1 AND u.role='MANAGER' AND (u.name ILIKE $2 OR u.phone ILIKE $2 OR u.nid ILIKE $2) ORDER BY u.created_at,u.id`,
      [a.organizationId, "%" + q.search + "%"],
      q,
    );
  }
  async addManager(a: Actor, d: z.infer<typeof s.managerInput>) {
    // Argon2 is expensive; calculate outside the short database transaction.
    const passwordHash = await hash(d.password);
    return this.db.tx(async (c) => {
      const u = await one(
        c,
        "INSERT INTO users(organization_id,role,name,phone,nid,password_hash,created_by) VALUES($1,'MANAGER',$2,$3,$4,$5,$6) RETURNING id",
        [a.organizationId, d.name, d.phone, d.nid, passwordHash, a.id],
      );
      await audit(c, a, "manager.created", u.id);
      return { id: u.id };
    });
  }
  async editManager(a: Actor, id: string, d: z.infer<typeof s.managerEdit>) {
    const passwordHash = d.password ? await hash(d.password) : undefined;
    return this.db.tx(async (c) => {
      const u = await one(
        c,
        "SELECT * FROM users WHERE organization_id=$1 AND id=$2 AND role='MANAGER' FOR UPDATE",
        [a.organizationId, id],
      );
      checkVersion(u.version, d.version);
      await c.query(
        "UPDATE users SET name=$1,phone=$2,nid=$3,active=$4,password_hash=COALESCE($5,password_hash),version=version+1 WHERE id=$6",
        [d.name, d.phone, d.nid ?? u.nid, d.active, passwordHash ?? null, id],
      );
      if (!d.active || passwordHash || u.phone !== d.phone || u.nid !== (d.nid ?? u.nid)) {
        // Changes to manager identity or credentials revoke existing app sessions.
        await c.query("DELETE FROM app_sessions WHERE user_id=$1", [id]);
        await c.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      }
      await audit(c, a, "manager.updated", id, { active: d.active, passwordChanged: !!passwordHash });
      return { id };
    });
  }
  residents(a: Actor, q: ListQuery) {
    return paginate(
      this.db,
      `SELECT u.id,u.name,u.phone,u.active,u.version,t.id AS "tenancyId",t.room_id AS "roomId",t.start_date AS "moveIn",r.number AS "roomNumber",h.id AS "houseId",h.name AS "houseName",rt.amount_minor::text AS "rentMinor",mi.serial AS meter FROM users u LEFT JOIN tenancies t ON t.resident_id=u.id AND ${activeTenancy} LEFT JOIN rooms r ON r.id=t.room_id LEFT JOIN houses h ON h.id=r.house_id LEFT JOIN rent_terms rt ON rt.tenancy_id=t.id AND rt.effective_from<=(now() AT TIME ZONE 'Asia/Dhaka')::date AND (rt.effective_to IS NULL OR rt.effective_to>(now() AT TIME ZONE 'Asia/Dhaka')::date) LEFT JOIN meter_installations mi ON mi.room_id=r.id AND mi.removed_at IS NULL WHERE u.organization_id=$1 AND u.role='RESIDENT' AND ($2::uuid IS NULL OR h.id=$2) AND (u.name ILIKE $3 OR r.number ILIKE $3 OR u.phone ILIKE $3) ORDER BY u.created_at,u.id`,
      [a.organizationId, q.houseId || null, "%" + q.search + "%"],
      q,
    );
  }
  async addResident(a: Actor, d: z.infer<typeof s.residentInput>) {
    return this.db.tx(async (c) => {
      const u = await one(
        c,
        "INSERT INTO users(organization_id,role,name,phone,created_by) VALUES($1,'RESIDENT',$2,$3,$4) RETURNING id",
        [a.organizationId, d.name, d.phone, a.id],
      );
      const t = await this.tenancies.allocate(
        c,
        a,
        u.id,
        d.roomId,
        d.startDate,
        d.rentMinor,
      );
      await audit(c, a, "resident.created", u.id, { tenancyId: t.id });
      return { ...u, tenancyId: t.id };
    });
  }
  async editResident(a: Actor, id: string, d: z.infer<typeof s.residentEdit>) {
    return this.db.tx(async (c) => {
      const u = await one(
        c,
        "SELECT * FROM users WHERE organization_id=$1 AND id=$2 AND role='RESIDENT' FOR UPDATE",
        [a.organizationId, id],
      );
      checkVersion(u.version, d.version);
      if (
        d.active === false &&
        (
          await c.query(
            "SELECT 1 FROM tenancies WHERE resident_id=$1 AND NOT cancelled AND (end_date IS NULL OR end_date>(now() AT TIME ZONE 'Asia/Dhaka')::date) LIMIT 1",
            [id],
          )
        ).rowCount
      )
        throw new ConflictException(
          "End active and scheduled tenancies before deactivating an account",
        );
      await c.query(
        "UPDATE users SET name=$1,phone=$2,active=$3,version=version+1 WHERE id=$4",
        [d.name, d.phone, d.active ?? u.active, id],
      );
      if (d.active === false)
        await c.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      await audit(c, a, "resident.updated", id);
      return { id };
    });
  }
}
