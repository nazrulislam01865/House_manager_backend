import { Injectable, Inject } from "@nestjs/common";
import { Database } from "../database/database.service.js";
import type { Actor } from "../common/context.js";
import { activeTenancy, paginate } from "../common/pagination.js";
import type { ListQuery } from "../common/validation.js";
@Injectable()
export class ReportingService {
  constructor(@Inject(Database) private db: Database) {}
  async dashboard(a: Actor, month: string, houseId?: string) {
    const args = [a.organizationId, houseId || null, month + "-01"];
    const totals = await this.db.query(
      `SELECT type,COALESCE(sum(amount_minor),0)::text AS "amountMinor",COALESCE(sum(paid_minor),0)::text AS "paidMinor",COALESCE(sum(amount_minor-paid_minor),0)::text AS "remainingMinor",count(*) FILTER(WHERE amount_minor>paid_minor)::int AS due,count(*)::int AS count FROM bills WHERE organization_id=$1 AND ($2::uuid IS NULL OR house_id=$2) AND month=$3 AND lifecycle='ISSUED' GROUP BY type`,
      args,
    );
    const [counts] = await this.db.query(
      `SELECT (SELECT count(*)::int FROM houses WHERE organization_id=$1 AND NOT archived AND ($2::uuid IS NULL OR id=$2)) AS houses,(SELECT count(*)::int FROM rooms r JOIN houses h ON h.id=r.house_id WHERE r.organization_id=$1 AND NOT h.archived AND ($2::uuid IS NULL OR r.house_id=$2)) AS rooms,(SELECT count(*)::int FROM tenancies t JOIN rooms r ON r.id=t.room_id JOIN houses h ON h.id=r.house_id WHERE t.organization_id=$1 AND NOT h.archived AND ($2::uuid IS NULL OR r.house_id=$2) AND ${activeTenancy}) AS occupied`,
      args.slice(0, 2),
    );
    return {
      ...counts,
      vacant: counts.rooms - counts.occupied,
      rent: totals.find((x) => x.type === "rent") || {
        amountMinor: "0",
        paidMinor: "0",
        remainingMinor: "0",
        due: 0,
        count: 0,
      },
      electricity: totals.find((x) => x.type === "electricity") || {
        amountMinor: "0",
        paidMinor: "0",
        remainingMinor: "0",
        due: 0,
        count: 0,
      },
      asOf: new Date().toISOString(),
    };
  }
  houses(a: Actor, q: ListQuery) {
    return paginate(
      this.db,
      `SELECT h.id,h.name,COALESCE((SELECT string_agg(u.name,', ') FROM manager_assignments ma JOIN users u ON u.id=ma.manager_id WHERE ma.house_id=h.id AND ma.valid_to IS NULL),'Unassigned') AS managers,(SELECT count(*)::int FROM rooms r WHERE r.house_id=h.id) AS rooms,COALESCE(sum(b.amount_minor-b.paid_minor) FILTER(WHERE b.type='rent'),0)::text AS "rentRemaining",COALESCE(sum(b.amount_minor-b.paid_minor) FILTER(WHERE b.type='electricity'),0)::text AS "electricityRemaining" FROM houses h LEFT JOIN bills b ON b.house_id=h.id AND b.lifecycle='ISSUED' AND b.month=$2 WHERE h.organization_id=$1 AND NOT h.archived GROUP BY h.id ORDER BY h.name,h.id`,
      [
        a.organizationId,
        (q.month || new Date().toISOString().slice(0, 7)) + "-01",
      ],
      q,
    );
  }
  activity(a: Actor, q: ListQuery) {
    return paginate(
      this.db,
      'SELECT id,action,resource_id AS "resourceId",detail,created_at AS "createdAt" FROM audit_events WHERE organization_id=$1 ORDER BY created_at DESC,id DESC',
      [a.organizationId],
      q,
    );
  }
  async health() {
    await this.db.query("SELECT 1");
    return { status: "ok", database: "connected" };
  }
}
