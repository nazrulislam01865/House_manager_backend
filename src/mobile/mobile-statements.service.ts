import { Injectable, Inject, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Database } from '../database/database.service.js';
import type { MobileActor } from './mobile.service.js';

export type StatementLine = {
  id: string; type: 'rent'|'electricity'; room: string; roomId: string;
  resident: string; phone: string | null; residentId: string;
  month: string; dueDate: string; amountMinor: string; paidMinor: string;
  remainingMinor: string; status: string; segments: MeterSegment[];
  payments: StatementPayment[];
};
export type MeterSegment = {meter: string|null; previous: string|null; current: string|null; usage: string|null; rate: string|null};
export type StatementPayment = {id:string; receipt:string; kind:string; method:string; date:string; amountMinor:string; collectedBy:string};
export type StatementSummary = {count:number; billedMinor:string; collectedMinor:string; remainingMinor:string};
export type MonthlyStatement = {
  month:string; house:{id:string;name:string;address:string};
  summary:{rent:StatementSummary; electricity:StatementSummary}; bills:StatementLine[];
};

const blank = ():StatementSummary => ({count:0,billedMinor:'0',collectedMinor:'0',remainingMinor:'0'});

@Injectable()
export class MobileStatementsService {
  constructor(@Inject(Database) private readonly db:Database) {}

  async monthly(actor:MobileActor, month:string, houseId:string):Promise<MonthlyStatement> {
    if (actor.role!=='MANAGER') throw new ForbiddenException('Manager access required');
    // Authorization is performed on every request and is scoped to the current
    // manager assignment. Never accept a client-supplied organization or owner.
    const [house] = await this.db.query(`SELECT h.id,h.name,h.address FROM houses h
      JOIN manager_assignments ma ON ma.house_id=h.id AND ma.manager_id=$3 AND ma.valid_to IS NULL
      WHERE h.id=$1 AND h.organization_id=$2 AND NOT h.archived LIMIT 1`,
      [houseId, actor.organizationId, actor.id]);
    if (!house) throw new NotFoundException('House not found in your assigned properties');

    const rows = await this.db.query(`SELECT b.id,b.type,b.month::text AS month,b.due_date::text AS "dueDate",
      b.room_id AS "roomId",r.number AS room,b.resident_id AS "residentId",
      u.name AS resident,u.phone,b.amount_minor::text AS "amountMinor",
      b.paid_minor::text AS "paidMinor",(b.amount_minor-b.paid_minor)::text AS "remainingMinor",
      COALESCE(e.segments,'[]'::json) AS segments
      FROM bills b
      JOIN rooms r ON r.id=b.room_id AND r.organization_id=b.organization_id
      JOIN users u ON u.id=b.resident_id AND u.organization_id=b.organization_id
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('meter',mi.serial,'previous',pr.reading::text,
          'current',cr.reading::text,'usage',bs.usage::text,'rate',bs.rate::text)
          ORDER BY mi.installed_at,bs.id) AS segments
        FROM bill_segments bs
        JOIN meter_installations mi ON mi.id=bs.installation_id
        JOIN meter_readings pr ON pr.id=bs.previous_reading_id
        JOIN meter_readings cr ON cr.id=bs.current_reading_id
        WHERE bs.bill_id=b.id
      ) e ON TRUE
      WHERE b.organization_id=$1 AND b.house_id=$2 AND b.month=$3::date
        AND b.lifecycle='ISSUED' AND b.type IN ('rent','electricity')
      ORDER BY r.number,b.type,b.id`, [actor.organizationId, houseId,month+'-01']);

    const ids = rows.map(row=>row.id as string);
    const payments = ids.length ? await this.db.query(`SELECT p.id,p.bill_id AS "billId",
      p.receipt_number AS receipt,p.kind,p.method,p.received_at::text AS date,
      p.amount_minor::text AS "amountMinor",u.name AS "collectedBy"
      FROM payments p JOIN users u ON u.id=p.actor_id
      WHERE p.organization_id=$1 AND p.bill_id=ANY($2::uuid[])
      ORDER BY p.received_at,p.recorded_at,p.id`,[actor.organizationId,ids]) : [];
    const byBill = new Map<string, StatementPayment[]>();
    for (const p of payments) {
      const billId=p.billId as string;
      if (!byBill.has(billId)) byBill.set(billId,[]);
      byBill.get(billId)!.push({
        id:String(p.id),receipt:String(p.receipt),kind:String(p.kind),
        method:String(p.method),date:String(p.date),
        amountMinor:String(p.amountMinor),collectedBy:String(p.collectedBy),
      });
    }
    const summary = {rent:blank(),electricity:blank()};
    const bills:StatementLine[] = rows.map(row=>{
      const amount=BigInt(row.amountMinor), paid=BigInt(row.paidMinor);
      const type = row.type as 'rent'|'electricity';
      const tally=summary[type];
      tally.count++;
      tally.billedMinor=(BigInt(tally.billedMinor)+amount).toString();
      tally.collectedMinor=(BigInt(tally.collectedMinor)+paid).toString();
      tally.remainingMinor=(BigInt(tally.remainingMinor)+amount-paid).toString();
      return {
        id:String(row.id),type,room:String(row.room),roomId:String(row.roomId),
        resident:String(row.resident),residentId:String(row.residentId),
        phone:row.phone==null?null:String(row.phone),month:String(row.month),
        dueDate:String(row.dueDate),amountMinor:String(row.amountMinor),
        paidMinor:String(row.paidMinor),remainingMinor:String(row.remainingMinor),
        status:paid>=amount?'Paid':paid===0n?'Unpaid':'Partial',
        segments:row.segments as MeterSegment[],payments:byBill.get(String(row.id))??[],
      };
    });
    return {month,house:{id:house.id,name:house.name,address:house.address},summary,bills};
  }
}
