import {
  Injectable,
  Inject,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from "@nestjs/common";
import { AuthService, digest, same } from "./auth.service.js";
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(AuthService) private auth: AuthService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    req.actor = await this.auth.session(req.cookies?.hl_session || "");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      const allowed = (
        process.env.FRONTEND_ORIGINS || "http://localhost:3000"
      ).split(",");
      if (origin && !allowed.includes(origin))
        throw new ForbiddenException("Origin not allowed");
      const csrf = req.get("X-CSRF-Token") || "";
      if (!csrf || !same(digest(csrf), req.actor.csrfHash))
        throw new ForbiddenException("Invalid CSRF token");
    }
    return true;
  }
}
