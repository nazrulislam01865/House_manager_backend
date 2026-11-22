import { Injectable, Inject, BadRequestException, ForbiddenException, NotFoundException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Database } from '../database/database.service.js';
import { audit } from '../common/context.js';
import type { MobileActor } from './mobile.service.js';

export interface ProfileUpdate {
  name: string;
  phone?: string;
  email?: string | null;
  nid?: string | null;
  presentAddress?: string | null;
  permanentAddress?: string | null;
  emergencyContact?: string | null;
  occupation?: string | null;
}
type MediaKind = 'avatar' | 'nid';
const maxImageBytes = 1_500_000;
const normalize = (s: string | null | undefined): string | null => s?.trim() || null;
const phone = (value: string) => value.startsWith('+88') ? value : '+88' + value;
function imageMime(bytes: Buffer): {mime: string;extension: string} | null {
  if (bytes.length>=3 && bytes[0]===0xff && bytes[1]===0xd8 && bytes[2]===0xff) return {mime:'image/jpeg',extension:'jpg'};
  if (bytes.length>=8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return {mime:'image/png',extension:'png'};
  if (bytes.length>=12 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP') return {mime:'image/webp',extension:'webp'};
  return null;
}

@Injectable()
export class MobileProfilesService {
  constructor(@Inject(Database) private readonly db: Database) {}

  private async permitted(a:MobileActor, target:string): Promise<void> {
    if (target===a.id) return;
    if (a.role!=='MANAGER') throw new ForbiddenException('You can only access your own profile');
    const [resident] = await this.db.query(`SELECT 1 FROM users u JOIN tenancies t ON t.resident_id=u.id
      JOIN rooms r ON r.id=t.room_id JOIN houses h ON h.id=r.house_id
      JOIN manager_assignments ma ON ma.house_id=h.id
      WHERE u.id=$1 AND u.organization_id=$2 AND u.role='RESIDENT' AND u.active
        AND ma.manager_id=$3 AND ma.valid_to IS NULL AND NOT h.archived
        AND NOT t.cancelled
        AND (t.end_date IS NULL OR t.end_date>(now() AT TIME ZONE 'Asia/Dhaka')::date) LIMIT 1`,
      [target,a.organizationId,a.id]);
    if (!resident) throw new ForbiddenException('Resident is not in a currently assigned room');
  }

  async get(a:MobileActor,target=a.id) {
    await this.permitted(a,target);
    const [row] = await this.db.query(`SELECT u.id,u.name,u.phone,u.role,u.nid,
      COALESCE(d.email,legacy.email) AS email,d.present_address AS "presentAddress",
      d.permanent_address AS "permanentAddress",d.emergency_contact AS "emergencyContact",d.occupation,
      (d.profile_image_path IS NOT NULL) AS "hasProfileImage",(d.nid_image_path IS NOT NULL) AS "hasNidImage",
      d.profile_image_updated_at::text AS "profileImageVersion",d.nid_image_updated_at::text AS "nidImageVersion"
      FROM users u LEFT JOIN mobile_profile_details d ON d.user_id=u.id
      LEFT JOIN mobile_resident_profiles legacy ON legacy.user_id=u.id
      WHERE u.id=$1 AND u.organization_id=$2 AND u.active`,[target,a.organizationId]);
    if (!row) throw new NotFoundException('Profile not found');
    return row;
  }

  async update(a:MobileActor,data:ProfileUpdate,target=a.id) {
    await this.permitted(a,target);
    // PATCH semantics: omitted optional values stay unchanged, explicit null
    // clears them. Form clients send all fields, but other clients need safety.
    const existing=await this.get(a,target);
    const normalizedPhone = data.phone === undefined ? undefined : phone(data.phone);
    if (normalizedPhone) {
      const [taken] = await this.db.query('SELECT 1 FROM users WHERE phone=$1 AND id<>$2 LIMIT 1',[normalizedPhone,target]);
      if (taken) throw new ConflictException('Mobile number is already used by another account');
    }
    const values={
      nid:data.nid===undefined?existing.nid:normalize(data.nid),
      email:data.email===undefined?existing.email:normalize(data.email),
      presentAddress:data.presentAddress===undefined?existing.presentAddress:normalize(data.presentAddress),
      permanentAddress:data.permanentAddress===undefined?existing.permanentAddress:normalize(data.permanentAddress),
      emergencyContact:data.emergencyContact===undefined?existing.emergencyContact:normalize(data.emergencyContact),
      occupation:data.occupation===undefined?existing.occupation:normalize(data.occupation),
    };
    try {
      return await this.db.tx(async c => {
        await c.query(`UPDATE users SET name=$1,phone=COALESCE($2,phone),nid=$3,version=version+1
          WHERE id=$4 AND organization_id=$5`,[data.name.trim(),normalizedPhone??null,values.nid,target,a.organizationId]);
        await c.query(`INSERT INTO mobile_profile_details(user_id,email,present_address,permanent_address,emergency_contact,occupation)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET
          email=EXCLUDED.email,present_address=EXCLUDED.present_address,permanent_address=EXCLUDED.permanent_address,
          emergency_contact=EXCLUDED.emergency_contact,occupation=EXCLUDED.occupation,updated_at=now()`,[
          target,values.email,values.presentAddress,values.permanentAddress,values.emergencyContact,values.occupation]);
        await c.query(`INSERT INTO mobile_resident_profiles(user_id,email)
          SELECT $1,$2 WHERE EXISTS(SELECT 1 FROM users WHERE id=$1 AND role='RESIDENT')
          ON CONFLICT(user_id) DO UPDATE SET email=EXCLUDED.email,updated_at=now()`,[target,values.email]);
        await audit(c,a,target===a.id?'mobile.profile.updated':'mobile.resident.profile.updated',target);
        return {ok:true};
      });
    } catch(error) {
      if(error && typeof error==='object' && 'code' in error && error.code==='23505')
        throw new ConflictException('This mobile number or NID is already in use');
      throw error;
    }
  }

  private storageConfig() {
    const url=process.env.SUPABASE_URL?.trim().replace(/\/$/,'');
    const key=(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)?.trim();
    const bucket=process.env.SUPABASE_PROFILE_BUCKET?.trim() || 'houseledger-profiles';
    if (!url || !key || !/^https:\/\/[a-zA-Z0-9.-]+$/.test(url)) {
      throw new ServiceUnavailableException('Private image storage is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY (or legacy service role key).');
    }
    if(!/^[a-zA-Z0-9_-]{3,80}$/.test(bucket)) throw new ServiceUnavailableException('Invalid private storage bucket configuration');
    if(key.startsWith('sb_publishable_') || key.startsWith('sb_anon_')) throw new ServiceUnavailableException('Storage requires a server-side Supabase secret key');
    return {url,key,bucket};
  }
  private storageUrl(object:string) {
    const cfg=this.storageConfig();
    const path=object.split('/').map(encodeURIComponent).join('/');
    return {cfg, url:`${cfg.url}/storage/v1/object/${encodeURIComponent(cfg.bucket)}/${path}`};
  }
  private storageHeaders(key:string):Record<string,string> {
    // The new sb_secret_ keys are opaque API keys, not JWT bearer tokens.
    // Legacy service_role JWT keys continue to use Authorization: Bearer.
    return key.startsWith('sb_secret_')
      ? {apikey:key}
      : {apikey:key,authorization:`Bearer ${key}`};
  }
  private async storageDelete(path:string) {
    try {const {url,cfg}=this.storageUrl(path);await fetch(url,{method:'DELETE',headers:this.storageHeaders(cfg.key),signal:AbortSignal.timeout(10000)});}catch { /* The object is private; retry cleanup separately if needed. */ }
  }

  async upload(a:MobileActor,target:string,kind:MediaKind,base64:string) {
    await this.permitted(a,target);
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new BadRequestException('Invalid base64 image');
    const bytes=Buffer.from(base64,'base64');
    if (bytes.length===0 || bytes.length>maxImageBytes) throw new BadRequestException('Image must be 1.5 MB or smaller');
    const type=imageMime(bytes);
    if(!type) throw new BadRequestException('Use a JPEG, PNG, or WebP image');
    const existing=await this.get(a,target);
    const old=await this.db.query(`SELECT ${kind==='avatar'?'profile_image_path':'nid_image_path'} AS path FROM mobile_profile_details WHERE user_id=$1`,[target]);
    const oldPath=old[0]?.path as string | undefined;
    const object=`profiles/${target}/${kind}/${randomUUID()}.${type.extension}`;
    const {url,cfg}=this.storageUrl(object);
    let response:Response;
    try {
      response=await fetch(url,{method:'POST',headers:{...this.storageHeaders(cfg.key),'Content-Type':type.mime,'x-upsert':'false','cache-control':'no-store'},body:new Uint8Array(bytes),signal:AbortSignal.timeout(16000)});
    } catch {throw new ServiceUnavailableException('Image storage is temporarily unavailable');}
    if(!response.ok) throw new ServiceUnavailableException('Could not upload image. Verify the private Supabase Storage bucket exists.');
    try {
      await this.db.tx(async c=>{
        const column=kind==='avatar'?'profile_image_path':'nid_image_path';
        const stamp=kind==='avatar'?'profile_image_updated_at':'nid_image_updated_at';
        await c.query(`INSERT INTO mobile_profile_details(user_id,${column},${stamp}) VALUES ($1,$2,now())
          ON CONFLICT(user_id) DO UPDATE SET ${column}=EXCLUDED.${column},${stamp}=now(),updated_at=now()`,[target,object]);
        await audit(c,a,`mobile.profile.${kind}.uploaded`,target);
      });
    } catch(error) {await this.storageDelete(object);throw error;}
    if(oldPath) await this.storageDelete(oldPath);
    return {ok:true,hasProfileImage:kind==='avatar'||existing.hasProfileImage,hasNidImage:kind==='nid'||existing.hasNidImage};
  }

  async remove(a:MobileActor,target:string,kind:MediaKind) {
    await this.permitted(a,target);
    const column=kind==='avatar'?'profile_image_path':'nid_image_path';
    const stamp=kind==='avatar'?'profile_image_updated_at':'nid_image_updated_at';
    const [old]=await this.db.query(`SELECT ${column} AS path FROM mobile_profile_details WHERE user_id=$1`,[target]);
    await this.db.tx(async c=>{
      await c.query(`UPDATE mobile_profile_details SET ${column}=NULL,${stamp}=NULL,updated_at=now() WHERE user_id=$1`,[target]);
      await audit(c,a,`mobile.profile.${kind}.removed`,target);
    });
    if(old?.path) await this.storageDelete(old.path);
    return {ok:true};
  }

  async download(a:MobileActor,target:string,kind:MediaKind):Promise<{bytes:Buffer;mime:string}> {
    // Admin can see house resident portraits for their organization, but cannot
    // read another person's NID scan or modify their profile through this API.
    if(a.role==='ADMIN' && kind==='avatar' && target!==a.id) {
      const [resident]=await this.db.query(`SELECT 1 FROM users WHERE id=$1 AND organization_id=$2 AND role='RESIDENT' AND active`,[target,a.organizationId]);
      if(!resident) throw new ForbiddenException('Avatar is outside your organization');
    } else await this.permitted(a,target);
    const column=kind==='avatar'?'profile_image_path':'nid_image_path';
    const [profile]=await this.db.query(`SELECT ${column} AS path FROM mobile_profile_details WHERE user_id=$1`,[target]);
    if(!profile?.path) throw new NotFoundException('No image uploaded');
    const {url,cfg}=this.storageUrl(profile.path);
    // Private files use the authenticated download endpoint, never the public URL.
    const authenticatedUrl=url.replace('/storage/v1/object/', '/storage/v1/object/authenticated/');
    let response:Response;
    try {response=await fetch(authenticatedUrl,{headers:this.storageHeaders(cfg.key),signal:AbortSignal.timeout(16000)});}
    catch {throw new ServiceUnavailableException('Could not load image');}
    if(!response.ok) throw new ServiceUnavailableException('Could not load image');
    const bytes=Buffer.from(await response.arrayBuffer());
    const type=imageMime(bytes);
    if(!type || bytes.length>maxImageBytes) throw new ServiceUnavailableException('Invalid stored image');
    return {bytes,mime:type.mime};
  }
}
