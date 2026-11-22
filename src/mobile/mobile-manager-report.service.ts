import { ForbiddenException, Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Database } from '../database/database.service.js';
import type { MobileActor } from './mobile.service.js';
import { MobileStatementsService, type MonthlyStatement, type StatementLine, type MeterSegment, type StatementPayment } from './mobile-statements.service.js';

export type ManagerReportBill = StatementLine & { houseId: string; houseName: string };
export type ManagerReportReceipt = {
  id: string; receipt: string; date: string; kind: string; method: string;
  amountMinor: string; billType: string; billMonth: string;
  houseName: string; houseId: string; room: string; resident: string; collectedBy: string;
};
export type ManagerHouseReport = {
  houseId: string; name: string; rooms: number; occupied: number; vacant: number;
  rentBilledMinor: string; electricityBilledMinor: string;
  rentPaidMinor: string; electricityPaidMinor: string;
  rentDueMinor: string; electricityDueMinor: string;
};
export type ManagerReport = {
  month: string; generatedAt: string; scope: 'all'|'house'; houses: ManagerHouseReport[];
  total: { rooms: number; occupied: number; vacant: number;
    billedMinor: string; rentBilledMinor: string; electricityBilledMinor: string;
    paidAgainstMonthMinor: string; remainingForMonthMinor: string;
    cashReceivedMinor: string; rentReceivedMinor: string; electricityReceivedMinor: string;
    outstandingThroughMonthMinor: string; priorOutstandingMinor: string; outstandingBillCount: number;
  };
  bills: ManagerReportBill[]; receipts: ManagerReportReceipt[];
  dues: ManagerReportBill[];
  methods: { method: string; receivedMinor: string }[];
  trend: { month: string; billedMinor: string; receivedMinor: string }[];
  expenseTrackingAvailable: false;
};

function add(parts: string[]): string { return parts.reduce((sum, x) => sum + BigInt(x), 0n).toString(); }
function net(kind: string, amount: string): string { return (BigInt(kind === 'REVERSAL' ? '-1' : '1') * BigInt(amount)).toString(); }
function monthStart(month: string, offset: number): string {
  const [y,m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(y,m - 1 + offset,1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
}

/** Manager-only, scoped to active assignments. Read-only over recorded ledger data. */
@Injectable()
export class MobileManagerReportService {
  constructor(@Inject(Database) private readonly db: Database,
    @Inject(MobileStatementsService) private readonly statements: MobileStatementsService) {}

  async full(actor: MobileActor, month: string, houseId?: string): Promise<ManagerReport> {
    if (actor.role !== 'MANAGER') throw new ForbiddenException('Manager access required');
    const assigned = await this.db.query(`SELECT h.id,h.name FROM houses h
      JOIN manager_assignments ma ON ma.house_id=h.id AND ma.manager_id=$2 AND ma.valid_to IS NULL
      WHERE h.organization_id=$1 AND NOT h.archived
      ORDER BY h.name,h.id`,[actor.organizationId,actor.id]);
    if (houseId && !assigned.some(h => h.id === houseId))
      throw new NotFoundException('House not found in your assigned properties');
    const houses = houseId ? assigned.filter(h => h.id === houseId) : assigned;
    const ids = houses.map(h => h.id as string);
    const emptyTotal: ManagerReport['total'] = {
      rooms:0,occupied:0,vacant:0,billedMinor:'0',rentBilledMinor:'0',electricityBilledMinor:'0',
      paidAgainstMonthMinor:'0',remainingForMonthMinor:'0',cashReceivedMinor:'0',
      rentReceivedMinor:'0',electricityReceivedMinor:'0',outstandingThroughMonthMinor:'0',
      priorOutstandingMinor:'0',outstandingBillCount:0,
    };
    if (ids.length === 0) return {
      month,generatedAt:new Date().toISOString(),scope:houseId?'house':'all',houses:[],
      total:emptyTotal,bills:[],receipts:[],dues:[],methods:[],trend:[],expenseTrackingAvailable:false,
    };

    // Reuse the existing authoritative, authorization-checked bill statement,
    // preserving meter segments, exact settled values and reversal receipts.
    // Batch to prevent unbounded DB fan-out for managers with many assignments.
    const monthStatements: { houseId: string; value: MonthlyStatement }[] = [];
    for (let start=0; start<ids.length; start+=6) {
      const batch=await Promise.all(ids.slice(start,start+6).map(async id => ({
        houseId:id, value:await this.statements.monthly(actor,month,id),
      })));
      monthStatements.push(...batch);
    }
    const bills: ManagerReportBill[] = monthStatements.flatMap(({houseId:id,value}) =>
      value.bills.map(b => ({...b,houseId:id,houseName:value.house.name})));

    const [occupancy, receiptRows, dueRows, billTrendRows, receiptTrendRows] = await Promise.all([
      this.db.query(`SELECT h.id AS "houseId",count(r.id)::int AS rooms,
        count(t.room_id)::int AS occupied
        FROM houses h LEFT JOIN rooms r ON r.house_id=h.id
        LEFT JOIN LATERAL (
          SELECT t.room_id FROM tenancies t WHERE t.room_id=r.id AND NOT t.cancelled
           AND t.start_date<=(now() AT TIME ZONE 'Asia/Dhaka')::date
           AND (t.end_date IS NULL OR t.end_date>(now() AT TIME ZONE 'Asia/Dhaka')::date)
          LIMIT 1
        )t ON true WHERE h.organization_id=$1 AND h.id=ANY($2::uuid[])
        GROUP BY h.id`,[actor.organizationId,ids]),
      this.db.query(`SELECT p.id,p.receipt_number AS receipt,p.received_at::text AS date,
        p.kind,p.method,p.amount_minor::text AS "amountMinor",b.type AS "billType",
        b.month::text AS "billMonth",h.id AS "houseId",h.name AS "houseName",
        r.number AS room,ru.name AS resident,cu.name AS "collectedBy"
        FROM payments p JOIN bills b ON b.id=p.bill_id AND b.organization_id=p.organization_id
        JOIN houses h ON h.id=b.house_id
        JOIN rooms r ON r.id=b.room_id JOIN users ru ON ru.id=b.resident_id
        JOIN users cu ON cu.id=p.actor_id
        WHERE p.organization_id=$1 AND b.house_id=ANY($2::uuid[])
          AND b.lifecycle='ISSUED' AND p.received_at >= $3::date
          AND p.received_at < ($3::date + interval '1 month')
        ORDER BY p.received_at DESC,p.recorded_at DESC,p.id DESC`,
        [actor.organizationId,ids,month+'-01']),
      this.db.query(`SELECT b.id,b.type,b.month::text AS month,b.due_date::text AS "dueDate",
        b.room_id AS "roomId",r.number AS room,b.resident_id AS "residentId",
        ru.name AS resident,ru.phone,b.amount_minor::text AS "amountMinor",
        b.paid_minor::text AS "paidMinor",(b.amount_minor-b.paid_minor)::text AS "remainingMinor",
        h.id AS "houseId",h.name AS "houseName"
        FROM bills b JOIN houses h ON h.id=b.house_id
        JOIN rooms r ON r.id=b.room_id JOIN users ru ON ru.id=b.resident_id
        WHERE b.organization_id=$1 AND b.house_id=ANY($2::uuid[])
          AND b.lifecycle='ISSUED' AND b.month <= $3::date AND b.amount_minor>b.paid_minor
        ORDER BY b.month ASC,h.name,r.number,b.id`,[actor.organizationId,ids,month+'-01']),
      this.db.query(`SELECT to_char(b.month,'YYYY-MM') AS month,
          coalesce(sum(b.amount_minor),0)::text AS "billedMinor"
          FROM bills b WHERE b.organization_id=$1 AND b.house_id=ANY($2::uuid[])
          AND b.lifecycle='ISSUED' AND b.month >= $3::date AND b.month <= $4::date
          GROUP BY b.month ORDER BY b.month`,
        [actor.organizationId,ids,monthStart(month,-5)+'-01',month+'-01']),
      this.db.query(`SELECT to_char(date_trunc('month',p.received_at),'YYYY-MM') AS month,
          coalesce(sum(CASE WHEN p.kind='REVERSAL' THEN -p.amount_minor ELSE p.amount_minor END),0)::text AS "receivedMinor"
          FROM payments p JOIN bills b ON b.id=p.bill_id AND b.organization_id=p.organization_id
          WHERE p.organization_id=$1 AND b.house_id=ANY($2::uuid[]) AND b.lifecycle='ISSUED'
          AND p.received_at >= $3::date AND p.received_at < ($4::date + interval '1 month')
          GROUP BY date_trunc('month',p.received_at) ORDER BY month`,
        [actor.organizationId,ids,monthStart(month,-5)+'-01',month+'-01']),
    ]);

    // Outstanding bills may be from previous months. Include their full
    // payment/reversal history and meter detail, not only the remaining figure.
    const dueIds=dueRows.map(d=>String(d.id));
    const [duePaymentRows,dueMeterRows]=dueIds.length?await Promise.all([
      this.db.query(`SELECT p.id,p.bill_id AS "billId",p.receipt_number AS receipt,p.kind,p.method,
        p.received_at::text AS date,p.amount_minor::text AS "amountMinor",u.name AS "collectedBy"
        FROM payments p JOIN users u ON u.id=p.actor_id
        WHERE p.organization_id=$1 AND p.bill_id=ANY($2::uuid[])
        ORDER BY p.received_at,p.recorded_at,p.id`,[actor.organizationId,dueIds]),
      this.db.query(`SELECT bs.bill_id AS "billId",mi.serial AS meter,
        pr.reading::text AS previous,cr.reading::text AS current,
        bs.usage::text AS usage,bs.rate::text AS rate
        FROM bill_segments bs JOIN meter_installations mi ON mi.id=bs.installation_id
        JOIN meter_readings pr ON pr.id=bs.previous_reading_id
        JOIN meter_readings cr ON cr.id=bs.current_reading_id
        WHERE bs.bill_id=ANY($1::uuid[])
        ORDER BY bs.bill_id,mi.installed_at,bs.id`,[dueIds]),
    ]):[[],[]];
    const paymentsByDueBill=new Map<string,StatementPayment[]>();
    for(const p of duePaymentRows){
      const id=String(p.billId);
      if(!paymentsByDueBill.has(id))paymentsByDueBill.set(id,[]);
      paymentsByDueBill.get(id)!.push({id:String(p.id),receipt:String(p.receipt),
        kind:String(p.kind),method:String(p.method),date:String(p.date),
        amountMinor:String(p.amountMinor),collectedBy:String(p.collectedBy)});
    }
    const metersByDueBill=new Map<string,MeterSegment[]>();
    for(const m of dueMeterRows){
      const id=String(m.billId);
      if(!metersByDueBill.has(id))metersByDueBill.set(id,[]);
      metersByDueBill.get(id)!.push({meter:m.meter==null?null:String(m.meter),
        previous:m.previous==null?null:String(m.previous),current:m.current==null?null:String(m.current),
        usage:m.usage==null?null:String(m.usage),rate:m.rate==null?null:String(m.rate)});
    }
    const occupancies=new Map<string,(typeof occupancy)[number]>(occupancy.map(r=>[String(r.houseId),r] as const));
    const summaryByHouse = new Map<string,MonthlyStatement['summary']>(monthStatements.map(({houseId:id,value})=>[id,value.summary] as const));
    const houseResults:ManagerHouseReport[]=houses.map(h=>{
      const s=summaryByHouse.get(h.id)!;
      const o=occupancies.get(h.id);
      const rooms=Number(o?.rooms ?? 0), occupied=Number(o?.occupied ?? 0);
      return {houseId:String(h.id),name:String(h.name),rooms,occupied,vacant:rooms-occupied,
        rentBilledMinor:s.rent.billedMinor,electricityBilledMinor:s.electricity.billedMinor,
        rentPaidMinor:s.rent.collectedMinor,electricityPaidMinor:s.electricity.collectedMinor,
        rentDueMinor:s.rent.remainingMinor,electricityDueMinor:s.electricity.remainingMinor};
    });
    const receipts:ManagerReportReceipt[]=receiptRows.map(p=>({
      id:String(p.id),receipt:String(p.receipt),date:String(p.date),kind:String(p.kind),method:String(p.method),
      amountMinor:net(String(p.kind),String(p.amountMinor)),billType:String(p.billType),billMonth:String(p.billMonth),
      houseName:String(p.houseName),houseId:String(p.houseId),room:String(p.room),resident:String(p.resident),
      collectedBy:String(p.collectedBy),
    }));
    const dues:ManagerReportBill[]=dueRows.map(d=>({
      id:String(d.id),type:d.type as 'rent'|'electricity',room:String(d.room),roomId:String(d.roomId),
      resident:String(d.resident),residentId:String(d.residentId),phone:d.phone==null?null:String(d.phone),
      month:String(d.month),dueDate:String(d.dueDate),amountMinor:String(d.amountMinor),
      paidMinor:String(d.paidMinor),remainingMinor:String(d.remainingMinor),
      status:BigInt(d.paidMinor)===0n?'Unpaid':'Partial',
      segments:metersByDueBill.get(String(d.id))??[],payments:paymentsByDueBill.get(String(d.id))??[],
      houseId:String(d.houseId),houseName:String(d.houseName),
    }));
    const methodTotals=new Map<string,bigint>();
    for(const r of receipts) methodTotals.set(r.method,(methodTotals.get(r.method)??0n)+BigInt(r.amountMinor));
    const methods=[...methodTotals.entries()].map(([method,amount])=>({method,receivedMinor:String(amount)}));
    const billedTrends=new Map<string,string>(billTrendRows.map(r=>[String(r.month),String(r.billedMinor)] as const));
    const receiptTrends=new Map<string,string>(receiptTrendRows.map(r=>[String(r.month),String(r.receivedMinor)] as const));
    const trend=Array.from({length:6},(_,i)=>{
      const key=monthStart(month,i-5);
      return {month:key,billedMinor:billedTrends.get(key)??'0',receivedMinor:receiptTrends.get(key)??'0'};
    });
    const total:ManagerReport['total']={
      rooms:houseResults.reduce((n,h)=>n+h.rooms,0),
      occupied:houseResults.reduce((n,h)=>n+h.occupied,0),
      vacant:houseResults.reduce((n,h)=>n+h.vacant,0),
      billedMinor:add(bills.map(b=>b.amountMinor)),
      rentBilledMinor:add(bills.filter(b=>b.type==='rent').map(b=>b.amountMinor)),
      electricityBilledMinor:add(bills.filter(b=>b.type==='electricity').map(b=>b.amountMinor)),
      paidAgainstMonthMinor:add(bills.map(b=>b.paidMinor)),
      remainingForMonthMinor:add(bills.map(b=>b.remainingMinor)),
      cashReceivedMinor:add(receipts.map(r=>r.amountMinor)),
      rentReceivedMinor:add(receipts.filter(r=>r.billType==='rent').map(r=>r.amountMinor)),
      electricityReceivedMinor:add(receipts.filter(r=>r.billType==='electricity').map(r=>r.amountMinor)),
      outstandingThroughMonthMinor:add(dues.map(d=>d.remainingMinor)),
      priorOutstandingMinor:add(dues.filter(d=>d.month.substring(0,7)<month).map(d=>d.remainingMinor)),
      outstandingBillCount:dues.length,
    };
    return {
      month,generatedAt:new Date().toISOString(),scope:houseId?'house':'all',
      houses:houseResults,total,bills,receipts,dues,methods,trend,expenseTrackingAvailable:false,
    };
  }
}
