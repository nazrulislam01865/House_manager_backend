import {
  Injectable,
  Inject,
  UnauthorizedException,
  HttpException,
} from "@nestjs/common";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { verify, hash } from "argon2";
import { Database } from "../database/database.service.js";
export const digest = (v: string) =>
  createHash("sha256").update(v).digest("hex");
export const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
@Injectable()
export class AuthService {
  private readonly dummyHash = hash(randomBytes(32).toString("hex"));
  constructor(@Inject(Database) private db: Database) {}
  async login(identifier: string, password: string, ip: string, role: "ADMIN" | "MANAGER" = "ADMIN") {
    const identity = identifier.trim().toLowerCase();
    const normalizedPhone = identity.startsWith("0") ? "+88" + identity : identity;
    const keys = [digest("account:" + role + ":" + identity), digest("network:" + ip)];
    for (const key of keys) {
      const [r] = await this.db.query(
        `INSERT INTO login_attempts(key,attempts) VALUES($1,1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_attempts.window_start<now()-interval '15 minutes' THEN 1 ELSE login_attempts.attempts+1 END,window_start=CASE WHEN login_attempts.window_start<now()-interval '15 minutes' THEN now() ELSE login_attempts.window_start END RETURNING attempts`,
        [key],
      );
      if (r.attempts > (key === keys[0] ? 10 : 100))
        throw new HttpException(
          "Too many attempts. Try again in 15 minutes.",
          429,
        );
    }
    const [user] = await this.db.query(
      "SELECT id,name,phone,password_hash,organization_id FROM users WHERE (phone=$1 OR (role='ADMIN' AND lower(username)=$2)) AND role=$3 AND active",
      [normalizedPhone, identity, role],
    );
    if (
      !(await verify(
        user?.password_hash || (await this.dummyHash),
        password,
      )) ||
      !user?.password_hash
    )
      throw new UnauthorizedException("Invalid phone or password");
    const token = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex");
    if (role === "MANAGER") {
      await this.db.query(
        "INSERT INTO app_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')",
        [user.id, digest(token)],
      );
    } else {
      await this.db.query(
        "INSERT INTO sessions(user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",
        [user.id, digest(token), digest(csrf)],
      );
    }
    await this.db.query("DELETE FROM login_attempts WHERE key=$1", [keys[0]]);
    return {
      token,
      csrf,
      user: { id: user.id, name: user.name, role },
    };
  }
  async session(token: string) {
    const [a] = await this.db.query(
      `SELECT u.id,u.name,u.organization_id AS "organizationId",s.id AS "sessionId",s.csrf_hash AS "csrfHash" FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active AND u.role='ADMIN'`,
      [digest(token)],
    );
    if (!a) throw new UnauthorizedException("Sign in to continue");
    return a;
  }
  async appSession(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException("Invalid app session");
    const [user] = await this.db.query(
      `SELECT u.id,u.name,u.phone,u.organization_id AS "organizationId",s.id AS "sessionId",
        COALESCE((SELECT json_agg(json_build_object('id',h.id,'name',h.name))
          FROM manager_assignments ma JOIN houses h ON h.id=ma.house_id
          WHERE ma.manager_id=u.id AND ma.valid_to IS NULL AND NOT h.archived),'[]') AS houses
       FROM app_sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>now() AND u.role='MANAGER' AND u.active`,
      [digest(token)],
    );
    if (!user) throw new UnauthorizedException("Invalid app session");
    return user;
  }
  async logoutApp(sessionId: string) {
    await this.db.query("DELETE FROM app_sessions WHERE id=$1", [sessionId]);
  }
  async logout(id: string) {
    await this.db.query("DELETE FROM sessions WHERE id=$1", [id]);
  }
}
