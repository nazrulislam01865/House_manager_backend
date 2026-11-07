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
import { CollectionsService } from "./collections.service.js";
import { AdminGuard } from "../auth/auth.guard.js";
import { Current, type Actor } from "../common/context.js";
import {
  Validate,
  listQuery,
  minor,
  date,
  text,
} from "../common/validation.js";
const payment = z
  .object({
    amountMinor: minor,
    method: z.enum(["Cash", "Bank transfer", "bKash", "Nagad"]),
    receivedAt: date,
  })
  .strict();
const reason = z.object({ reason: text }).strict();
const query = listQuery.extend({
  type: z.enum(["rent", "electricity"]).optional(),
});
@Controller()
@UseGuards(AdminGuard)
export class CollectionsController {
  constructor(
    @Inject(CollectionsService) private service: CollectionsService,
  ) {}
  @BodyDoc(payment)
  @Post("rent/bills/:id/payments")
  rent(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(payment)) d: z.infer<typeof payment>,
    @Headers("idempotency-key") key: string,
  ) {
    return this.service.collect(a, "rent", id, d, key);
  }
  @BodyDoc(payment)
  @Post("electricity/bills/:id/payments")
  electricity(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(payment)) d: z.infer<typeof payment>,
    @Headers("idempotency-key") key: string,
  ) {
    return this.service.collect(a, "electricity", id, d, key);
  }
  @BodyDoc(reason)
  @Post("payments/:id/reversal")
  reverse(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(reason)) d: z.infer<typeof reason>,
    @Headers("idempotency-key") key: string,
  ) {
    return this.service.reverse(a, id, d.reason, key);
  }
  @Get("collections") list(
    @Current() a: Actor,
    @Query(new Validate(query)) q: z.infer<typeof query>,
  ) {
    return this.service.list(a, q, q.type);
  }
  @Get("receipts/:id") receipt(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.receipt(a, id);
  }
}
