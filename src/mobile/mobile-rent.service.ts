import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Database } from '../database/database.service.js';
import { audit, outbox } from '../common/context.js';
import { idempotent } from '../billing/idempotency.js';
import type { MobileActor } from './mobile.service.js';

/** Additional mobile-specific rent operations. Existing web billing and collections are untouched. */
@Injectable()
export class MobileRentService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Invoked daily by a secret-protected Vercel Cron in Asia/Dhaka's current month.
   * Re-running is safe thanks to the existing active-bill unique index.
   * Do not recreate deliberately voided bills (match existing web billing policy).
   * Historical debt stays on the original bill: never duplicate it in a new charge.
   */
  async runMonthlyRent() {
    // Format using parts rather than relying on locale-dependent date order.
    const parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Dhaka',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    const get = (field: string) => parts.find(p => p.type === field)?.value ?? '';
    const month = `${get('year')}-${get('month')}-01`;
    const result = await this.db.query<{id:string}>(`
      INSERT INTO bills(organization_id,tenancy_id,house_id,room_id,resident_id,type,month,due_date,amount_minor,scope_owner_id)
      SELECT t.organization_id,t.id,r.house_id,r.id,t.resident_id,'rent',$1::date,$1::date+6,rt.amount_minor,t.created_by
      FROM tenancies t JOIN rooms r ON r.id=t.room_id JOIN houses h ON h.id=r.house_id
      JOIN rent_terms rt ON rt.tenancy_id=t.id AND rt.effective_from<=$1::date
         AND (rt.effective_to IS NULL OR rt.effective_to>=($1::date+interval '1 month')::date)
      WHERE NOT t.cancelled AND NOT h.archived AND t.start_date<=$1::date
        AND (t.end_date IS NULL OR t.end_date>=($1::date+interval '1 month')::date)
        AND NOT EXISTS(SELECT 1 FROM bills old WHERE old.tenancy_id=t.id AND old.type='rent' AND old.month=$1::date)
      ON CONFLICT(tenancy_id,type,month) WHERE lifecycle='ISSUED' DO NOTHING
      RETURNING id`,[month]);
    return {month: month.substring(0,7),created:result.length};
  }

  /** Apply one collected amount to the oldest unpaid bill of the same tenancy first.
   * Each allocation remains a normal payment and gets the existing receipt number.
   * This makes an aggregated monthly balance payable without double-counting arrears.
   */
  async collect(a: MobileActor, d:{roomId:string;month:string;amountMinor:string;method:'Cash'|'Bank transfer'|'bKash'|'Nagad';receivedAt:string},key:string) {
    if (a.role !== 'MANAGER') throw new ForbiddenException('Manager access required');
    const nowParts = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Dhaka',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    const get = (field:string) => nowParts.find(p=>p.type===field)?.value ?? '';
    const today = `${get('year')}-${get('month')}-${get('day')}`;
    const targetMonth = `${d.month}-01`;
    if (targetMonth > today) throw new BadRequestException('Future rent bills cannot be collected');
    if (d.receivedAt < targetMonth || d.receivedAt > today) throw new BadRequestException('Payment date must be in the selected month or later, and not in the future');
    if (!/^\d+$/.test(d.amountMinor) || BigInt(d.amountMinor) <= 0n) throw new BadRequestException('Amount must be positive');
    return this.db.tx(c => idempotent(c,a,'mobile.rent.collect:'+d.roomId,key,d,async () => {
      const scope = (await c.query(`SELECT t.id AS "tenancyId" FROM rooms r
         JOIN houses h ON h.id=r.house_id AND NOT h.archived
         JOIN manager_assignments ma ON ma.house_id=r.house_id AND ma.manager_id=$3 AND ma.valid_to IS NULL
         JOIN tenancies t ON t.room_id=r.id AND t.organization_id=$2 AND NOT t.cancelled
          AND t.start_date<=$4::date AND (t.end_date IS NULL OR t.end_date>=($4::date+interval '1 month')::date)
         WHERE r.id=$1 AND r.organization_id=$2 LIMIT 1`,[d.roomId,a.organizationId,a.id,targetMonth])).rows[0];
      if (!scope) throw new ForbiddenException('Room has no active tenancy in this month, or is not assigned to you');
      const monthly = (await c.query(`SELECT id FROM bills WHERE tenancy_id=$1 AND type='rent' AND month=$2::date AND lifecycle='ISSUED'`,[scope.tenancyId,targetMonth])).rows[0];
      if (!monthly) throw new ConflictException('Generate this month\'s rent bill before collecting payment');
      const pending = (await c.query(`SELECT id,month::text AS month,amount_minor,paid_minor
        FROM bills WHERE organization_id=$1 AND tenancy_id=$2 AND type='rent' AND lifecycle='ISSUED'
        AND month<=$3::date AND paid_minor<amount_minor
        ORDER BY month ASC,id ASC FOR UPDATE`,[a.organizationId,scope.tenancyId,targetMonth])).rows;
      let left = BigInt(d.amountMinor);
      const total = pending.reduce((sum,b)=>sum+BigInt(b.amount_minor)-BigInt(b.paid_minor),0n);
      if (left > total) throw new ConflictException('Payment exceeds this room\'s unpaid rent balance');
      const allocations: {paymentId:string;receiptNumber:string;billId:string;month:string;amountMinor:string}[] = [];
      for(const b of pending) {
        if(left===0n) break;
        const remaining = BigInt(b.amount_minor)-BigInt(b.paid_minor);
        const take = remaining<left ? remaining:left;
        const row = (await c.query(`INSERT INTO payments(organization_id,bill_id,kind,amount_minor,method,received_at,actor_id)
            VALUES($1,$2,'PAYMENT',$3,$4,$5,$6) RETURNING id,receipt_number AS "receiptNumber"`,
          [a.organizationId,b.id,take.toString(),d.method,d.receivedAt,a.id])).rows[0];
        await c.query('UPDATE bills SET paid_minor=paid_minor+$1,version=version+1 WHERE id=$2',[take.toString(),b.id]);
        allocations.push({paymentId:row.id,receiptNumber:row.receiptNumber,billId:b.id,month:b.month,amountMinor:take.toString()});
        left-=take;
      }
      if (left!==0n || allocations.length===0) throw new NotFoundException('No unpaid rent found');
      await audit(c,a,'mobile.rent.payment',d.roomId,{month:d.month,amountMinor:d.amountMinor,paymentIds:allocations.map(p=>p.paymentId)});
      await outbox(c,a,'payment.recorded',{paymentIds:allocations.map(p=>p.paymentId),roomId:d.roomId});
      return {allocations,remainingMinor:(total-BigInt(d.amountMinor)).toString()};
    }));
  }
}
