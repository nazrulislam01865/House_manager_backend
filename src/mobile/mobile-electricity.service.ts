import { BadRequestException, ConflictException, ForbiddenException, Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { Database, type Transaction } from '../database/database.service.js';
import { audit, outbox } from '../common/context.js';
import { idempotent } from '../billing/idempotency.js';
import type { MobileActor } from './mobile.service.js';

type ReadingInput = { roomId: string; month: string; readAt: string; current: string };
type PaymentInput = { roomId: string; month: string; amountMinor: string; method: 'Cash'|'Bank transfer'|'bKash'|'Nagad'; receivedAt: string };

const dhakaDate = () => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};

/** Mobile-only electricity billing. The original web billing service is unchanged.
 * Every period starts unbilled; a real reading is required before a charge exists.
 * Bills/payments remain tied to their original month and tenancy.
 */
@Injectable()
export class MobileElectricityService {
  constructor(@Inject(Database) private readonly db: Database) {}

  private async calculate(c: Transaction, a: MobileActor, d: ReadingInput, lock: boolean) {
    if (a.role !== 'MANAGER') throw new ForbiddenException('Manager access required');
    const monthStart = `${d.month}-01`;
    const monthEnd = new Date(`${monthStart}T00:00:00Z`);
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
    const nextMonth = monthEnd.toISOString().slice(0, 10);
    const today = dhakaDate();
    if (monthStart > today) throw new BadRequestException('Future months cannot be billed before a meter reading');
    if (d.readAt < monthStart || d.readAt >= nextMonth || d.readAt > today)
      throw new BadRequestException('Reading date must be within the selected month and not in the future');

    const room = (await c.query(`SELECT r.id,r.house_id AS "houseId" FROM rooms r
      JOIN houses h ON h.id=r.house_id AND NOT h.archived
      JOIN manager_assignments ma ON ma.house_id=h.id AND ma.manager_id=$3 AND ma.valid_to IS NULL
      WHERE r.id=$1 AND r.organization_id=$2 ${lock ? 'FOR UPDATE OF r' : ''}`,
      [d.roomId,a.organizationId,a.id])).rows[0];
    if (!room) throw new ForbiddenException('Room is not assigned to this manager');
    const installation = (await c.query(`SELECT mi.id,mi.serial,mi.installed_at::text AS "installedAt" FROM meter_installations mi
      WHERE mi.room_id=$1 AND mi.organization_id=$2 AND mi.removed_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
      [room.id,a.organizationId])).rows[0];
    if (!installation) throw new ConflictException('Link a meter with an opening reading before issuing an electricity bill');
    const previous = (await c.query(`SELECT id,read_at::text AS "readAt",reading::text AS reading FROM meter_readings
      WHERE installation_id=$1 AND accepted ORDER BY read_at DESC,id DESC LIMIT 1`,[installation.id])).rows[0];
    if (!previous) throw new ConflictException('Set the meter opening reading before issuing a bill');
    if (d.readAt <= previous.readAt)
      throw new ConflictException(`Reading date must be after the last accepted reading (${previous.readAt})`);
    if (d.readAt < installation.installedAt)
      throw new ConflictException('Reading cannot precede meter installation');
    const tenancy = (await c.query(`SELECT t.id,t.resident_id AS "residentId",t.created_by AS "ownerId",t.start_date::text AS "startDate"
      FROM tenancies t WHERE t.room_id=$1 AND t.organization_id=$2 AND NOT t.cancelled
      AND t.start_date<=$3::date AND (t.end_date IS NULL OR t.end_date>$3::date)
      ORDER BY t.start_date DESC LIMIT 1`,[room.id,a.organizationId,d.readAt])).rows[0];
    if (!tenancy) throw new ConflictException('Assign a resident for the reading date before issuing the bill');
    if (tenancy.startDate >= nextMonth)
      throw new ConflictException('The resident did not occupy this room during the selected billing month');

    // An installation baseline before a FIRST tenancy is valid. For later tenants,
    // require a distinct move-in reading rather than charging another tenant's usage.
    if (previous.readAt < tenancy.startDate) {
      const earlier = (await c.query(`SELECT 1 FROM bill_segments bs JOIN bills b ON b.id=bs.bill_id
        WHERE bs.installation_id=$1 AND b.tenancy_id<>$2 AND b.lifecycle='ISSUED' LIMIT 1`,
        [installation.id,tenancy.id])).rows[0];
      if (earlier) throw new ConflictException('This meter has an earlier tenant bill. Record a verified move-in meter baseline before billing the new resident');
    }
    const exists = (await c.query(`SELECT id FROM bills WHERE tenancy_id=$1 AND type='electricity'
      AND month=$2::date AND lifecycle='ISSUED' LIMIT 1`,[tenancy.id,monthStart])).rows[0];
    if (exists) throw new ConflictException('An electricity bill is already issued for this room and month');
    const tariff = (await c.query(`SELECT id,rate::text AS rate FROM tariff_versions
      WHERE house_id=$1 AND scope_owner_id IS NULL AND effective_from<=$2::date
      ORDER BY effective_from DESC LIMIT 1`,[room.houseId,monthStart])).rows[0];
    if (!tariff) throw new ConflictException('Set an electricity unit rate for this house before billing');
    if (new Decimal(d.current).lt(previous.reading)) throw new ConflictException('Current reading cannot be less than the previous reading');
    const usage = new Decimal(d.current).minus(previous.reading);
    const amountMinor = usage.mul(tariff.rate).mul(100).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toFixed(0);
    if (BigInt(amountMinor) > 1000000000000n) throw new BadRequestException('Electricity charge exceeds supported maximum');
    return {room,installation,previous,tenancy,tariff,usage:usage.toFixed(3),amountMinor};
  }

  async preview(a: MobileActor, d: ReadingInput) {
    return this.db.tx(async c => {
      const s = await this.calculate(c,a,d,false);
      return {roomId:d.roomId,meter:s.installation.serial,previous:s.previous.reading,
        current:d.current,usage:s.usage,rate:s.tariff.rate,amountMinor:s.amountMinor,
        previousReadingId:s.previous.id,tariffId:s.tariff.id};
    });
  }

  async issue(a: MobileActor,d: ReadingInput,key: string) {
    return this.db.tx(c => idempotent(c,a,'mobile.electricity.issue',key,d,async () => {
      const s = await this.calculate(c,a,d,true);
      const reading = (await c.query(`INSERT INTO meter_readings(installation_id,read_at,reading,created_by)
        VALUES($1,$2,$3,$4) RETURNING id`,[s.installation.id,d.readAt,d.current,a.id])).rows[0];
      const bill = (await c.query(`INSERT INTO bills(organization_id,tenancy_id,house_id,room_id,resident_id,type,month,due_date,amount_minor,scope_owner_id)
        VALUES($1,$2,$3,$4,$5,'electricity',$6,$7,$8,$9) RETURNING id`,
        [a.organizationId,s.tenancy.id,s.room.houseId,d.roomId,s.tenancy.residentId,`${d.month}-01`,d.readAt,s.amountMinor,s.tenancy.ownerId])).rows[0];
      await c.query(`INSERT INTO bill_segments(bill_id,installation_id,previous_reading_id,current_reading_id,usage,rate,tariff_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[bill.id,s.installation.id,s.previous.id,reading.id,s.usage,s.tariff.rate,s.tariff.id]);
      await audit(c,a,'mobile.electricity.issued',bill.id,{roomId:d.roomId,month:d.month,amountMinor:s.amountMinor});
      await outbox(c,a,'bill.issued',{billId:bill.id});
      return {id:bill.id,amountMinor:s.amountMinor};
    }));
  }

  /** Record a one-time verified opening meter value for a new tenancy.
   * This avoids assigning the previous occupant's unbilled consumption to the
   * new resident. It does not modify historical readings, bills or payments.
   */
  async handover(a:MobileActor,d:{roomId:string;readAt:string;current:string},key:string) {
    if(a.role!=='MANAGER')throw new ForbiddenException('Manager access required');
    if(d.readAt>dhakaDate())throw new BadRequestException('Opening reading cannot be dated in the future');
    return this.db.tx(c=>idempotent(c,a,'mobile.electricity.handover',key,d,async()=>{
      const tenancy=(await c.query(`SELECT t.id,t.start_date::text AS "startDate",r.id AS "roomId" FROM tenancies t
        JOIN rooms r ON r.id=t.room_id JOIN houses h ON h.id=r.house_id AND NOT h.archived
        JOIN manager_assignments ma ON ma.house_id=h.id AND ma.manager_id=$3 AND ma.valid_to IS NULL
        WHERE r.id=$1 AND t.organization_id=$2 AND NOT t.cancelled
          AND t.start_date<=(now() AT TIME ZONE 'Asia/Dhaka')::date
          AND (t.end_date IS NULL OR t.end_date>(now() AT TIME ZONE 'Asia/Dhaka')::date)
        ORDER BY t.start_date DESC LIMIT 1 FOR UPDATE OF r`,[d.roomId,a.organizationId,a.id])).rows[0];
      if(!tenancy)throw new ForbiddenException('No current resident assigned to this room');
      if(d.readAt!==tenancy.startDate)throw new BadRequestException('Opening reading date must match the resident move-in date');
      const meter=(await c.query(`SELECT id FROM meter_installations WHERE room_id=$1 AND organization_id=$2 AND removed_at IS NULL FOR UPDATE`,
        [d.roomId,a.organizationId])).rows[0];
      if(!meter)throw new ConflictException('Link a meter before recording a move-in reading');
      const previous=(await c.query(`SELECT read_at::text AS "readAt",reading::text AS reading FROM meter_readings
        WHERE installation_id=$1 AND accepted ORDER BY read_at DESC,id DESC LIMIT 1`,[meter.id])).rows[0];
      if(!previous)throw new ConflictException('The meter needs an installation baseline first');
      if(previous.readAt>=tenancy.startDate)
        throw new ConflictException('A meter opening reading already exists at or after move-in');
      const issued=(await c.query(`SELECT 1 FROM bills WHERE tenancy_id=$1 AND type='electricity' AND lifecycle='ISSUED' LIMIT 1`,
        [tenancy.id])).rows[0];
      if(issued)throw new ConflictException('Cannot change a move-in baseline after issuing an electricity bill');
      if(new Decimal(d.current).lt(previous.reading))throw new ConflictException('Opening reading cannot be below the previous meter value');
      const row=(await c.query(`INSERT INTO meter_readings(installation_id,read_at,reading,created_by)
        VALUES($1,$2,$3,$4) RETURNING id`,[meter.id,d.readAt,d.current,a.id])).rows[0];
      await audit(c,a,'mobile.electricity.handover',row.id,{roomId:d.roomId,tenancyId:tenancy.id,readAt:d.readAt});
      return {id:row.id};
    }));
  }

  /** Electricity arrears remain on their original monthly bills. Payments are
   * allocated oldest first, only within the same tenancy and up to the chosen month.
   */
  async collect(a:MobileActor,d:PaymentInput,key:string) {
    if(a.role!=='MANAGER') throw new ForbiddenException('Manager access required');
    const targetMonth=`${d.month}-01`;
    if(targetMonth>dhakaDate()) throw new BadRequestException('Cannot collect a future bill');
    if(d.receivedAt>dhakaDate() || d.receivedAt<targetMonth) throw new BadRequestException('Payment date must be in the selected month or later, not in the future');
    if(BigInt(d.amountMinor)<=0n) throw new BadRequestException('Payment amount must be positive');
    return this.db.tx(c=>idempotent(c,a,`mobile.electricity.collect:${d.roomId}`,key,d,async()=>{
      const tenancy=(await c.query(`SELECT t.id AS "tenancyId" FROM rooms r
        JOIN houses h ON h.id=r.house_id AND NOT h.archived
        JOIN manager_assignments ma ON ma.house_id=h.id AND ma.manager_id=$3 AND ma.valid_to IS NULL
        JOIN tenancies t ON t.room_id=r.id AND t.organization_id=$2 AND NOT t.cancelled
          AND t.start_date<($4::date+interval '1 month')::date
          AND (t.end_date IS NULL OR t.end_date>$4::date)
        WHERE r.id=$1 AND r.organization_id=$2 ORDER BY t.start_date DESC LIMIT 1`,
        [d.roomId,a.organizationId,a.id,targetMonth])).rows[0];
      if(!tenancy) throw new ForbiddenException('No authorized tenancy exists for this room and billing month');
      const pending=(await c.query(`SELECT id,month::text AS month,due_date::text AS "issuedAt",amount_minor,paid_minor FROM bills
        WHERE organization_id=$1 AND tenancy_id=$2 AND type='electricity' AND lifecycle='ISSUED'
        AND month<=$3::date AND paid_minor<amount_minor
        ORDER BY month ASC,id ASC FOR UPDATE`,[a.organizationId,tenancy.tenancyId,targetMonth])).rows;
      const total=pending.reduce((sum,b)=>sum+BigInt(b.amount_minor)-BigInt(b.paid_minor),0n);
      let left=BigInt(d.amountMinor);
      if(left>total) throw new ConflictException('Payment exceeds unpaid electricity balance');
      const allocations: {paymentId:string;receiptNumber:string;billId:string;month:string;amountMinor:string}[]=[];
      for(const pendingBill of pending) {
        if(left===0n)break;
        const stillOwed=BigInt(pendingBill.amount_minor)-BigInt(pendingBill.paid_minor);
        const received=left<stillOwed?left:stillOwed;
        if(pendingBill.month===targetMonth && d.receivedAt<pendingBill.issuedAt)
          throw new BadRequestException('Payment date cannot precede the issued electricity reading');
        const result=(await c.query(`INSERT INTO payments(organization_id,bill_id,kind,amount_minor,method,received_at,actor_id)
          VALUES($1,$2,'PAYMENT',$3,$4,$5,$6) RETURNING id,receipt_number AS "receiptNumber"`,
          [a.organizationId,pendingBill.id,received.toString(),d.method,d.receivedAt,a.id])).rows[0];
        await c.query('UPDATE bills SET paid_minor=paid_minor+$1,version=version+1 WHERE id=$2',[received.toString(),pendingBill.id]);
        allocations.push({paymentId:result.id,receiptNumber:result.receiptNumber,billId:pendingBill.id,month:pendingBill.month,amountMinor:received.toString()});
        left-=received;
      }
      if(left!==0n || allocations.length===0)throw new NotFoundException('No unpaid electricity for this tenancy');
      await audit(c,a,'mobile.electricity.payment',d.roomId,{month:d.month,amountMinor:d.amountMinor,paymentIds:allocations.map(p=>p.paymentId)});
      await outbox(c,a,'payment.recorded',{paymentIds:allocations.map(p=>p.paymentId),roomId:d.roomId});
      return {allocations,remainingMinor:(total-BigInt(d.amountMinor)).toString()};
    }));
  }
}
