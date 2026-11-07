import { Controller, Get, Query, UseGuards, Inject } from "@nestjs/common";
import { z } from "zod";
import { ReportingService } from "./reporting.service.js";
import { AdminGuard } from "../auth/auth.guard.js";
import { Current, type Actor } from "../common/context.js";
import {
  Validate,
  listQuery,
  type ListQuery,
  month,
  id,
} from "../common/validation.js";
const query = z.object({ month, houseId: id.optional() }).strict();
@Controller()
export class ReportingController {
  constructor(@Inject(ReportingService) private service: ReportingService) {}
  @Get("health") health() {
    return this.service.health();
  }
  @UseGuards(AdminGuard) @Get("dashboard") dashboard(
    @Current() a: Actor,
    @Query(new Validate(query)) q: z.infer<typeof query>,
  ) {
    return this.service.dashboard(a, q.month, q.houseId);
  }
  @UseGuards(AdminGuard) @Get("reports/houses") houses(
    @Current() a: Actor,
    @Query(new Validate(listQuery)) q: ListQuery,
  ) {
    return this.service.houses(a, q);
  }
  @UseGuards(AdminGuard) @Get("activity") activity(
    @Current() a: Actor,
    @Query(new Validate(listQuery)) q: ListQuery,
  ) {
    return this.service.activity(a, q);
  }
}
