import { BodyDoc } from "../common/api-body.js";
import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Req,
  Res,
  UseGuards,
  Inject,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { AuthService } from "./auth.service.js";
import { AdminGuard } from "./auth.guard.js";
import { Validate, phone, text, version } from "../common/validation.js";
import {
  Current,
  type Actor,
  audit,
  one,
  checkVersion,
} from "../common/context.js";
import { Database } from "../database/database.service.js";
const loginSchema = z.union([
  z.object({ identifier: z.string().trim().min(1).max(100), password: z.string().min(1).max(200) }).strict(),
  z.object({ phone, password: z.string().min(1).max(200) }).strict(),
]);
const profileSchema = z.object({ name: text, version }).strict();
@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private auth: AuthService,
    @Inject(Database) private db: Database,
  ) {}
  @BodyDoc(loginSchema)
  @Post("auth/web/login")
  async login(
    @Body(new Validate(loginSchema)) data: z.infer<typeof loginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (
      req.get("origin") &&
      !(process.env.FRONTEND_ORIGINS || "http://localhost:3000")
        .split(",")
        .includes(req.get("origin")!)
    )
      throw new ForbiddenException("Origin not allowed");
    if (!req.is("application/json"))
      throw new ForbiddenException("JSON requests required");
    const result = await this.auth.login(
      "identifier" in data ? data.identifier : data.phone,
      data.password,
      req.ip || "unknown",
    );
    const options = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      path: "/api",
      maxAge: 8 * 60 * 60 * 1000,
    };
    res.cookie("hl_session", result.token, options);
    return { user: result.user, csrf: result.csrf };
  }
  // App credentials are bearer-token only and never unlock admin web routes.
  @BodyDoc(loginSchema)
  @Post("auth/app/login")
  async appLogin(
    @Body(new Validate(loginSchema)) data: z.infer<typeof loginSchema>,
    @Req() req: Request,
  ) {
    if (!req.is("application/json"))
      throw new ForbiddenException("JSON requests required");
    const result = await this.auth.login(
      "identifier" in data ? data.identifier : data.phone,
      data.password,
      req.ip || "unknown",
      "MANAGER",
    );
    return { token: result.token, expiresInSeconds: 30 * 24 * 60 * 60, user: result.user };
  }
  private async appActor(req: Request) {
    const authorization = req.get("authorization") || "";
    const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
    if (!match) throw new UnauthorizedException("Bearer token required");
    return this.auth.appSession(match[1]);
  }
  @Get("auth/app/me")
  async appMe(@Req() req: Request) {
    const { sessionId, ...account } = await this.appActor(req);
    return { ...account, role: "MANAGER" };
  }
  @Post("auth/app/logout")
  async appLogout(@Req() req: Request) {
    const actor = await this.appActor(req);
    await this.auth.logoutApp(actor.sessionId);
    return { ok: true };
  }
  @UseGuards(AdminGuard) @Get("me") async me(@Current() a: Actor) {
    const [u] = await this.db.query(
      `SELECT u.id,u.name,u.username,u.phone,u.version,
        o.name AS "organizationName",o.currency,o.timezone
        FROM users u JOIN organizations o ON o.id=u.organization_id WHERE u.id=$1`,
      [a.id],
    );
    return { ...u, role: "ADMIN" };
  }
  @UseGuards(AdminGuard) @Get("auth/csrf") async csrf(@Current() a: Actor) {
    const { randomBytes } = await import("node:crypto");
    const token = randomBytes(32).toString("hex");
    const { digest } = await import("./auth.service.js");
    await this.db.query("UPDATE sessions SET csrf_hash=$1 WHERE id=$2", [
      digest(token),
      a.sessionId,
    ]);
    return { csrf: token };
  }
  @UseGuards(AdminGuard) @Post("auth/logout") async logout(
    @Current() a: Actor,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(a.sessionId);
    res.clearCookie("hl_session", { path: "/api" });
    return { ok: true };
  }
  @BodyDoc(profileSchema)
  @UseGuards(AdminGuard)
  @Patch("me/profile")
  async profile(
    @Current() a: Actor,
    @Body(new Validate(profileSchema)) d: z.infer<typeof profileSchema>,
  ) {
    return this.db.tx(async (c) => {
      const u = await one(
        c,
        "SELECT version FROM users WHERE id=$1 FOR UPDATE",
        [a.id],
      );
      checkVersion(u.version, d.version);
      await c.query("UPDATE users SET name=$1,version=version+1 WHERE id=$2", [
        d.name,
        a.id,
      ]);
      await audit(c, a, "profile.updated", a.id);
      return { ok: true };
    });
  }
}
