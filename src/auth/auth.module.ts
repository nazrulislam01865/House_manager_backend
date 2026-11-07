import { Global, Module } from "@nestjs/common";
import { AuthService } from "./auth.service.js";
import { AdminGuard } from "./auth.guard.js";
import { AuthController } from "./auth.controller.js";
@Global()
@Module({
  providers: [AuthService, AdminGuard],
  controllers: [AuthController],
  exports: [AuthService, AdminGuard],
})
export class AuthModule {}
