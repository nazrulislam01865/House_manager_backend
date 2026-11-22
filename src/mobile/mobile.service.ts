import { Injectable, Inject, ForbiddenException, UnauthorizedException, ConflictException, NotFoundException, BadRequestException, HttpException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { hash, verify } from 'argon2';
import { Database } from '../database/database.service.js';
import { digest } from '../auth/auth.service.js';
import { type Actor, audit, one } from '../common/context.js';
import { PropertiesService } from '../properties/properties.service.js';
import { MeterInstallationsService } from '../properties/meter-installations.service.js';
import { PeopleService } from '../people/people.service.js';
import { TenancyService } from '../people/tenancy.service.js';
import { BillsService } from '../billing/bills.service.js';
import { CollectionsService } from '../collections/collections.service.js';
import { MobileElectricityService } from './mobile-electricity.service.js';

export type MobileActor = Actor & { role: 'ADMIN'|'MANAGER'|'RESIDENT'; phone: string };
const todayDhaka = () => {
  const parts = new Intl.DateTimeFormat('en-GB',{ timeZone:'Asia/Dhaka', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
  const get = (name:string) => parts.find(part=>part.type===name)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};
const safePhone = (value: string) => value.startsWith('0') ? '+88' + value : value;
const validKey = (key?: string) => { if (!key || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(key)) throw new BadRequestException('Idempotency-Key UUID required'); return key; };

@Injectable()
export class MobileService {
  private readonly dummyPassword = hash(randomUUID());
  constructor(
    @Inject(Database) private db: Database,
    @Inject(PropertiesService) private properties: PropertiesService,
    @Inject(MeterInstallationsService) private installations: MeterInstallationsService,
    @Inject(PeopleService) private people: PeopleService,
    @Inject(TenancyService) private tenancies: TenancyService,
    @Inject(BillsService) private bills: BillsService,
    @Inject(CollectionsService) private collections: CollectionsService,
    @Inject(MobileElectricityService) private electricity: MobileElectricityService,
  ) {}

  async login(identifier: string, password: string, ip: string) {
    const normalized = identifier.trim().toLowerCase();
    const key = digest('mobile-login:' + normalized), networkKey = digest('mobile-network:' + ip);
    for (const attemptKey of [key, networkKey]) {
      const [r] = await this.db.query(`INSERT INTO login_attempts(key,attempts) VALUES($1,1)
         ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_attempts.window_start<now()-interval '15 minutes' THEN 1 ELSE login_attempts.attempts+1 END,
          window_start=CASE WHEN login_attempts.window_start<now()-interval '15 minutes' THEN now() ELSE login_attempts.window_start END
         RETURNING attempts`, [attemptKey]);
      if (r.attempts > (attemptKey === key ? 10 : 100)) throw new HttpException('Too many login attempts. Try again later.', 429);
    }
    const [account] = await this.db.query(`SELECT id,name,phone,role,password_hash FROM users
       WHERE active AND (phone=$1 OR (role='ADMIN' AND lower(username)=$2)) LIMIT 1`, [safePhone(normalized),normalized]);
    if (!(await verify(account?.password_hash || await this.dummyPassword, password)) || !account?.password_hash)
      throw new UnauthorizedException('Invalid credentials');
    const token = randomBytes(32).toString('hex');
    // The unique user index makes concurrent sign-ins atomic: the newest
    // successful login replaces the previous device's token immediately.
    await this.db.query(`INSERT INTO app_sessions(user_id,token_hash,expires_at)
      VALUES($1,$2,now()+interval '30 days')
      ON CONFLICT (user_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,
        expires_at=EXCLUDED.expires_at,created_at=now()`, [account.id,digest(token)]);
    await this.db.query('DELETE FROM login_attempts WHERE key=$1',[key]);
    return { token, expiresInSeconds: 30*24*60*60, user: { id:account.id,name:account.name,role:account.role } };
  }
  async session(token: string): Promise<MobileActor> {
    const [u] = await this.db.query(`SELECT u.id,u.name,u.phone,u.role,u.organization_id AS "organizationId",s.id AS "sessionId",s.expires_at AS "expiresAt"
      FROM app_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`,[digest(token)]);
    if (!u || !['ADMIN','MANAGER','RESIDENT'].includes(u.role)) throw new UnauthorizedException('Your session has ended or another device signed in. Sign in again.');
    return {id:u.id,name:u.name,phone:u.phone,role:u.role,organizationId:u.organizationId,sessionId:u.sessionId,csrfHash:''};
  }
  async me(a:MobileActor) {return {id:a.id,name:a.name,phone:a.phone,role:a.role};}
  async logout(a:MobileActor) {await this.db.query('DELETE FROM app_sessions WHERE id=$1',[a.sessionId]);return {ok:true};}
  private manager(a:MobileActor) {if(a.role!=='MANAGER') throw new ForbiddenException('Manager access required');}
  private async house(a:MobileActor, houseId:string) {
    this.manager(a);
    const [h] = await this.db.query(`SELECT h.id FROM houses h JOIN manager_assignments ma ON ma.house_id=h.id
      WHERE h.organization_id=$1 AND h.id=$2 AND NOT h.archived AND ma.manager_id=$3 AND ma.valid_to IS NULL LIMIT 1`,[a.organizationId,houseId,a.id]);
    if (!h) throw new ForbiddenException('House is not assigned to this manager');
  }
  private async room(a:MobileActor,roomId:string) {
    this.manager(a);
    const [r] = await this.db.query(`SELECT r.id,r.house_id AS "houseId" FROM rooms r JOIN houses h ON h.id=r.house_id
     JOIN manager_assignments ma ON ma.house_id=h.id AND ma.manager_id=$3 AND ma.valid_to IS NULL
     WHERE r.id=$1 AND r.organization_id=$2 AND NOT h.archived LIMIT 1`,[roomId,a.organizationId,a.id]);
    if (!r) throw new ForbiddenException('Room is not assigned to this manager');
    return r as {id:string;houseId:string};
  }
  private async resident(a:MobileActor,residentId:string) {
    this.manager(a);
    const [r] = await this.db.query(`SELECT t.id AS "tenancyId",t.room_id AS "roomId",r.house_id AS "houseId"
      FROM tenancies t JOIN rooms r ON r.id=t.room_id JOIN manager_assignments ma
       ON ma.house_id=r.house_id AND ma.manager_id=$3 AND ma.valid_to IS NULL
      WHERE t.resident_id=$1 AND t.organization_id=$2 AND NOT t.cancelled
       AND t.start_date<=(now() AT TIME ZONE 'Asia/Dhaka')::date
       AND (t.end_date IS NULL OR t.end_date>(now() AT TIME ZONE 'Asia/Dhaka')::date)
      ORDER BY t.start_date DESC LIMIT 1`,[residentId,a.organizationId,a.id]);
    if (!r) throw new ForbiddenException('Resident is not assigned to this manager');
    return r as {tenancyId:string;roomId:string;houseId:string};
  }
  private async bill(a:MobileActor,billId:string) {
    this.manager(a);
    const [b] = await this.db.query(`SELECT b.id,b.type,b.house_id AS "houseId" FROM bills b JOIN manager_assignments ma
      ON ma.house_id=b.house_id AND ma.manager_id=$3 AND ma.valid_to IS NULL
      WHERE b.id=$1 AND b.organization_id=$2 AND b.lifecycle='ISSUED' LIMIT 1`,[billId,a.organizationId,a.id]);
    if (!b) throw new ForbiddenException('Bill is not assigned to this manager');
    return b as {id:string;type:'rent'|'electricity';houseId:string};
  }
  private async scopedHouseIds(a:MobileActor) {
    const rows = await this.db.query(`SELECT h.id FROM houses h WHERE h.organization_id=$1 AND NOT h.archived AND
      ($2::text='ADMIN' OR ($2='MANAGER' AND EXISTS(SELECT 1 FROM manager_assignments ma WHERE ma.house_id=h.id AND ma.manager_id=$3 AND ma.valid_to IS NULL))
      OR ($2='RESIDENT' AND EXISTS(SELECT 1 FROM tenancies t JOIN rooms r ON r.id=t.room_id WHERE r.house_id=h.id AND t.resident_id=$3 AND NOT t.cancelled)))
      ORDER BY h.name,h.id`,[a.organizationId,a.role,a.id]);
    return rows.map(r=>r.id as string);
  }
  async bootstrap(a:MobileActor) {
    const ids = await this.scopedHouseIds(a);
    const personal = a.role==='RESIDENT';
    const houses = await this.db.query(`SELECT h.id,h.name,(SELECT u.name FROM manager_assignments ma JOIN users u ON u.id=ma.manager_id WHERE ma.house_id=h.id AND ma.valid_to IS NULL ORDER BY ma.valid_from DESC LIMIT 1) AS "managerName" FROM houses h WHERE h.id=ANY($1::uuid[]) ORDER BY h.name`,[ids]);
    const rooms = await this.db.query(`SELECT r.id,r.house_id AS "houseId",r.number,r.version,
      CASE WHEN $2::boolean AND t.resident_id IS DISTINCT FROM $3 THEN NULL ELSE r.rent_minor::text END AS "rentMinor",
      CASE WHEN $2::boolean AND t.resident_id IS DISTINCT FROM $3 THEN NULL ELSE mi.serial END AS "meterNumber",
      CASE WHEN $2::boolean AND t.resident_id IS DISTINCT FROM $3 THEN NULL ELSE mi.installed_at END AS "installedAt", 
      CASE WHEN $2::boolean AND t.resident_id IS DISTINCT FROM $3 THEN '0' ELSE COALESCE((SELECT mr.reading::text FROM meter_readings mr WHERE mr.installation_id=mi.id AND mr.accepted ORDER BY mr.read_at ASC LIMIT 1),'0') END AS "initialReading",
      CASE WHEN $2::boolean AND t.resident_id IS DISTINCT FROM $3 THEN NULL ELSE COALESCE((SELECT mr.read_at::text FROM meter_readings mr WHERE mr.installation_id=mi.id AND mr.accepted ORDER BY mr.read_at ASC LIMIT 1),mi.installed_at::text) END AS "initialReadingDate",
      CASE WHEN $2::boolean AND t.resident_id IS DISTINCT FROM $3 THEN NULL ELSE t.resident_id END AS "residentId",
      CASE WHEN $2::boolean AND t.resident_id IS DISTINCT FROM $3 THEN NULL ELSE rt.amount_minor::text END AS "currentRentMinor"
      FROM rooms r LEFT JOIN meter_installations mi ON mi.room_id=r.id AND mi.removed_at IS NULL
      LEFT JOIN LATERAL(SELECT * FROM tenancies t WHERE t.room_id=r.id AND NOT t.cancelled AND t.start_date<=(now() AT TIME ZONE 'Asia/Dhaka')::date
        AND (t.end_date IS NULL OR t.end_date>(now() AT TIME ZONE 'Asia/Dhaka')::date) ORDER BY t.start_date DESC LIMIT 1)t ON TRUE
      LEFT JOIN LATERAL(SELECT amount_minor FROM rent_terms rt WHERE rt.tenancy_id=t.id AND rt.effective_from<=(now() AT TIME ZONE 'Asia/Dhaka')::date AND (rt.effective_to IS NULL OR rt.effective_to>(now() AT TIME ZONE 'Asia/Dhaka')::date) ORDER BY rt.effective_from DESC LIMIT 1)rt ON TRUE
      WHERE r.house_id=ANY($1::uuid[]) AND ($2::boolean=false OR EXISTS(SELECT 1 FROM tenancies history WHERE history.room_id=r.id AND history.resident_id=$3 AND NOT history.cancelled)) ORDER BY r.number,r.id`,[ids,personal,a.id]);
    const roomIds = rooms.map(r=>r.id as string);
    const residents = await this.db.query(`SELECT u.id,u.name,u.phone,t.start_date::text AS "moveInDate",t.room_id AS "roomId",rt.amount_minor::text AS "rentMinor",u.active,mp.email
      FROM tenancies t JOIN users u ON u.id=t.resident_id
      JOIN rooms r ON r.id=t.room_id
      LEFT JOIN LATERAL(SELECT amount_minor FROM rent_terms rt WHERE rt.tenancy_id=t.id ORDER BY rt.effective_from DESC LIMIT 1)rt ON TRUE
      LEFT JOIN mobile_resident_profiles mp ON mp.user_id=u.id
      WHERE t.room_id=ANY($1::uuid[]) AND NOT t.cancelled
      AND ($2::boolean=false OR u.id=$3)
      ORDER BY t.start_date DESC,u.name`,[roomIds,personal,a.id]);
    const bills = await this.db.query(`SELECT b.id,b.room_id AS "roomId",b.resident_id AS "residentId",b.type,b.month::text AS month,b.amount_minor::text AS "amountMinor",b.paid_minor::text AS "paidMinor",b.tenancy_id AS "tenancyId",
      mi.serial AS "meterNumber",pr.reading::text AS "previousReading",cr.reading::text AS "currentReading",bs.rate::text AS "unitRate"
      FROM bills b LEFT JOIN bill_segments bs ON bs.bill_id=b.id
      LEFT JOIN meter_readings pr ON pr.id=bs.previous_reading_id LEFT JOIN meter_readings cr ON cr.id=bs.current_reading_id
      LEFT JOIN meter_installations mi ON mi.id=bs.installation_id
      WHERE b.lifecycle='ISSUED' AND b.room_id=ANY($1::uuid[]) AND ($2::boolean=false OR b.resident_id=$3)
      ORDER BY b.month DESC,b.id LIMIT 2500`,[roomIds,personal,a.id]);
    const billIds=bills.map(b=>b.id as string);
    const payments=await this.db.query(`SELECT p.id,p.bill_id AS "billId",p.amount_minor::text AS "amountMinor",p.kind,p.method,p.received_at::text AS date,u.name AS "collectedBy",p.receipt_number AS "receiptNumber"
      FROM payments p JOIN users u ON u.id=p.actor_id WHERE p.bill_id=ANY($1::uuid[])
      ORDER BY p.recorded_at,p.id LIMIT 6000`,[billIds]);
    const readings=await this.db.query(`SELECT mi.room_id AS "roomId",mi.serial AS "meterNumber",mr.reading::text AS reading,mr.read_at::text AS date
      FROM meter_readings mr JOIN meter_installations mi ON mi.id=mr.installation_id
      WHERE mi.room_id=ANY($1::uuid[]) AND mr.accepted AND
      ($2::boolean=false OR EXISTS(SELECT 1 FROM tenancies historical
         WHERE historical.room_id=mi.room_id AND historical.resident_id=$3
         AND NOT historical.cancelled AND mr.read_at>=historical.start_date
         AND (historical.end_date IS NULL OR mr.read_at<=historical.end_date)))
      ORDER BY mr.read_at DESC LIMIT 2500`,[roomIds,personal,a.id]);
    const rates=await this.db.query(`SELECT house_id AS "houseId",effective_from::text AS month,rate::text FROM tariff_versions
      WHERE house_id=ANY($1::uuid[]) AND scope_owner_id IS NULL ORDER BY effective_from`,[ids]);
    return {user:await this.me(a),houses,rooms,residents,bills,payments,readings,rates,serverToday:todayDhaka()};
  }
  async updateProfile(a:MobileActor,d:{name:string;phone?:string;email?:string|null}) {
    if(a.role==='ADMIN') throw new ForbiddenException('Admin mobile view is read-only');
    return this.db.tx(async c=>{
      const phone=d.phone?safePhone(d.phone):a.phone;
      await c.query('UPDATE users SET name=$1,phone=$2,version=version+1 WHERE id=$3 AND organization_id=$4',[d.name,phone,a.id,a.organizationId]);
      if(a.role==='RESIDENT' && d.email!==undefined) await c.query(`INSERT INTO mobile_resident_profiles(user_id,email) VALUES($1,$2)
        ON CONFLICT(user_id) DO UPDATE SET email=EXCLUDED.email,updated_at=now()`,[a.id,d.email]);
      await audit(c,a,'mobile.profile.updated',a.id);return {ok:true};
    });
  }
  async createRoom(a:MobileActor,d:{houseId:string;number:string;rentMinor:string;meter?:string;initialReading?:string;installedAt?:string}) {
    await this.house(a,d.houseId);
    if(d.meter && (!d.initialReading || !d.installedAt)) throw new BadRequestException('Meter requires installation date and baseline reading');
    return this.db.tx(async c=>{
      const r=await one(c,`INSERT INTO rooms(organization_id,house_id,number,rent_minor,created_by)
        VALUES($1,$2,$3,$4,$5) RETURNING id`,[a.organizationId,d.houseId,d.number,d.rentMinor,a.id]);
      if(d.meter){
        const mi=await one(c,`INSERT INTO meter_installations(organization_id,room_id,serial,installed_at)
           VALUES($1,$2,$3,$4) RETURNING id`,[a.organizationId,r.id,d.meter,d.installedAt]);
        await c.query(`INSERT INTO meter_readings(installation_id,read_at,reading,created_by) VALUES($1,$2,$3,$4)`,[mi.id,d.installedAt,d.initialReading,a.id]);
      }
      await audit(c,a,'mobile.room.created',r.id);return r;
    });
  }
  async updateRoom(a:MobileActor,id:string,d:{number:string;rentMinor:string;effectiveMonth:string}) {
    await this.room(a,id);
    return this.db.tx(async c=>{
      const r=await one(c,'SELECT * FROM rooms WHERE id=$1 AND organization_id=$2 FOR UPDATE',[id,a.organizationId]);
      const month=d.effectiveMonth+'-01';
      // A room-number-only edit must not rewrite rent terms or touch issued bills.
      if (BigInt(r.rent_minor) === BigInt(d.rentMinor)) {
        await c.query('UPDATE rooms SET number=$1,version=version+1 WHERE id=$2',[d.number,id]);
        await audit(c,a,'mobile.room.renamed',id);
        return {id};
      }
      // Existing rent bills may not be silently recalculated by a room edit.
      const [issued] = (await c.query(`SELECT id FROM bills WHERE room_id=$1 AND organization_id=$2 AND type='rent'
        AND lifecycle='ISSUED' AND month>=$3::date LIMIT 1`,[id,a.organizationId,month])).rows;
      if (issued) throw new ConflictException('Issued rent bills exist from this month. Choose a later effective month.');
      const [tenancy]=(await c.query(`SELECT t.id,t.start_date::text AS "startDate" FROM tenancies t
        WHERE t.room_id=$1 AND NOT t.cancelled
         AND t.start_date<=(now() AT TIME ZONE 'Asia/Dhaka')::date
         AND (t.end_date IS NULL OR t.end_date>(now() AT TIME ZONE 'Asia/Dhaka')::date)
        ORDER BY t.start_date DESC LIMIT 1`,[id])).rows;
      if (tenancy && month<tenancy.startDate) throw new ConflictException('Rent change cannot precede this tenancy');
      if(tenancy){
        const existing=(await c.query('SELECT id,effective_from::text AS "effectiveFrom",amount_minor::text AS "amountMinor" FROM rent_terms WHERE tenancy_id=$1 ORDER BY effective_from DESC LIMIT 1',[tenancy.id])).rows[0];
        if(existing && existing.effectiveFrom>month) throw new ConflictException('Cannot change rent before the latest rent revision');
        if(existing && existing.effectiveFrom===month){
          await c.query('UPDATE rent_terms SET amount_minor=$1 WHERE id=$2',[d.rentMinor,existing.id]);
        } else {
          if(existing) await c.query('UPDATE rent_terms SET effective_to=$1 WHERE id=$2',[month,existing.id]);
          await c.query('INSERT INTO rent_terms(tenancy_id,effective_from,amount_minor) VALUES($1,$2,$3)',[tenancy.id,month,d.rentMinor]);
        }
      }
      await c.query('UPDATE rooms SET number=$1,rent_minor=$2,version=version+1 WHERE id=$3', [d.number,d.rentMinor,id]);
      await audit(c,a,'mobile.room.updated',id,{before:r.rent_minor,after:d.rentMinor,month});
      return {id};
    });
  }
  async removeRoom(a:MobileActor,id:string) {
    await this.room(a,id);
    const [r]=await this.db.query('SELECT version FROM rooms WHERE id=$1 AND organization_id=$2',[id,a.organizationId]);
    return this.properties.deleteRoom(a,id,r.version);
  }
  async replaceMeter(a:MobileActor,roomId:string,d:{serial:string;installedAt:string;baseline:string}) {
    await this.room(a,roomId);
    const [installation]=await this.db.query('SELECT id FROM meter_installations WHERE room_id=$1 AND removed_at IS NULL',[roomId]);
    if (!installation) return this.installations.link(a,roomId,d);
    return this.installations.replace(a,installation.id,d);
  }
  async createResident(a:MobileActor,d:{roomId:string;name:string;phone:string;startDate:string;rentMinor:string}) {
    await this.room(a,d.roomId);
    const initialPassword=randomBytes(12).toString('base64url');
    const passwordHash=await hash(initialPassword);
    const result=await this.db.tx(async c=>{
      const user=await one(c,`INSERT INTO users(organization_id,role,name,phone,password_hash,created_by)
        VALUES($1,'RESIDENT',$2,$3,$4,$5) RETURNING id`,[a.organizationId,d.name,safePhone(d.phone),passwordHash,a.id]);
      const tenancy=await this.tenancies.allocate(c,a,user.id,d.roomId,d.startDate,d.rentMinor);
      await audit(c,a,'mobile.resident.created',user.id,{tenancyId:tenancy.id});
      return {id:user.id};
    });
    // Password is returned only on creation; never logged or exposed by read endpoints.
    return {...result,initialPassword};
  }
  async setResidentPassword(a:MobileActor,id:string,password:string) {
    await this.resident(a,id);
    const hashed=await hash(password);
    await this.db.tx(async c=>{
      await c.query('UPDATE users SET password_hash=$1,version=version+1 WHERE id=$2 AND organization_id=$3',[hashed,id,a.organizationId]);
      await c.query('DELETE FROM app_sessions WHERE user_id=$1',[id]);
      await audit(c,a,'mobile.resident.credentials.reset',id);
    });return {ok:true};
  }
  async updateResident(a:MobileActor,id:string,d:{name:string;phone:string}) {
    await this.resident(a,id);
    const [r]=await this.db.query('SELECT version FROM users WHERE id=$1 AND organization_id=$2',[id,a.organizationId]);
    return this.people.editResident(a,id,{name:d.name,phone:safePhone(d.phone),version:r.version});
  }
  async endResident(a:MobileActor,id:string,d:{endDate:string}) {
    const tenancy=await this.resident(a,id);
    return this.tenancies.end(a,tenancy.tenancyId,{endDate:d.endDate,reason:'Ended by assigned manager'});
  }
  async moveResident(a:MobileActor,id:string,d:{roomId:string;effectiveDate:string;rentMinor:string}) {
    const tenancy=await this.resident(a,id);
    await this.room(a,d.roomId);
    return this.tenancies.move(a,tenancy.tenancyId,d);
  }
  async generateRent(a:MobileActor,d:{houseId:string;month:string;dueDay:number},key:string) {await this.house(a,d.houseId);return this.bills.rentRun(a,d,validKey(key));}
  async previewElectricity(a:MobileActor,d:{roomId:string;month:string;readAt:string;current:string}) {await this.room(a,d.roomId);return this.electricity.preview(a,d);}
  async issueElectricity(a:MobileActor,d:{roomId:string;month:string;readAt:string;current:string},key:string) {
    await this.room(a,d.roomId);
    return this.electricity.issue(a,d,validKey(key));
  }
  async saveRate(a:MobileActor,d:{houseId:string;effectiveFrom:string;rate:string}) {await this.house(a,d.houseId);return this.bills.rate(a,d);}
  async payment(a:MobileActor,d:{billId:string;amountMinor:string;method:'Cash'|'Bank transfer'|'bKash'|'Nagad';receivedAt:string},key:string) {
    const b=await this.bill(a,d.billId);return this.collections.collect(a,b.type,d.billId,{amountMinor:d.amountMinor,method:d.method,receivedAt:d.receivedAt},validKey(key));
  }
}
