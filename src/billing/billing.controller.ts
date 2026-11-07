import { BodyDoc } from "../common/api-body.js";
import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  Headers,
  UseGuards,
  Inject,
  ParseUUIDPipe,
} from "@nestjs/common";
import { z } from "zod";
import { BillsService } from "./bills.service.js";
import { MeteringService } from "./metering.service.js";
import { AdminGuard } from "../auth/auth.guard.js";
import { Current, type Actor } from "../common/context.js";
import { Validate, listQuery, type ListQuery } from "../common/validation.js";
import * as s from "./billing.schemas.js";
@Controller()
@UseGuards(AdminGuard)
export class BillingController {
  constructor(
    @Inject(BillsService) private bills: BillsService,
    @Inject(MeteringService) private meters: MeteringService,
  ) {}
  @Get("rent/bills") rent(
    @Current() a: Actor,
    @Query(new Validate(listQuery)) q: ListQuery,
  ) {
    return this.bills.list(a, "rent", q);
  }
  @Get("electricity/bills") electricity(
    @Current() a: Actor,
    @Query(new Validate(listQuery)) q: ListQuery,
  ) {
    return this.bills.list(a, "electricity", q);
  }
  @Get("bills/:id") detail(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.bills.detail(a, id);
  }
  @BodyDoc(s.rentRun)
  @Post("rent/bill-runs")
  run(
    @Current() a: Actor,
    @Body(new Validate(s.rentRun)) d: z.infer<typeof s.rentRun>,
    @Headers("idempotency-key") key: string,
  ) {
    return this.bills.rentRun(a, d, key);
  }
  @BodyDoc(s.correctionInput)
  @Post("bills/:id/corrections")
  correct(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(s.correctionInput)) d: z.infer<typeof s.correctionInput>,
    @Headers("idempotency-key") key: string,
  ) {
    return this.bills.correct(a, id, d, key);
  }
  @BodyDoc(s.voidInput)
  @Post("bills/:id/void")
  void(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(s.voidInput)) d: z.infer<typeof s.voidInput>,
  ) {
    return this.bills.void(a, id, d);
  }
  @Get("tariffs") rates(
    @Current() a: Actor,
    @Query(new Validate(listQuery)) q: ListQuery,
  ) {
    return this.bills.rates(a, q);
  }
  @BodyDoc(s.rateInput)
  @Post("tariffs")
  rate(
    @Current() a: Actor,
    @Body(new Validate(s.rateInput)) d: z.infer<typeof s.rateInput>,
  ) {
    return this.bills.rate(a, d);
  }
  @BodyDoc(s.baselineInput)
  @Post("meter-readings/baseline")
  baseline(
    @Current() a: Actor,
    @Body(new Validate(s.baselineInput)) d: z.infer<typeof s.baselineInput>,
  ) {
    return this.meters.baseline(a, d);
  }
  @Get("rooms/:id/readings") readings(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.meters.readings(a, id);
  }
  @BodyDoc(s.electricityInput)
  @Post("electricity/previews")
  preview(
    @Current() a: Actor,
    @Body(new Validate(s.electricityInput))
    d: z.infer<typeof s.electricityInput>,
  ) {
    return this.meters.preview(a, d);
  }
  @BodyDoc(s.electricityIssue)
  @Post("electricity/bills")
  issue(
    @Current() a: Actor,
    @Body(new Validate(s.electricityIssue))
    d: z.infer<typeof s.electricityIssue>,
    @Headers("idempotency-key") key: string,
  ) {
    return this.meters.issue(a, d, key);
  }
}
