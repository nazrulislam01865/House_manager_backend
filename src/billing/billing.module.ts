import { Module } from "@nestjs/common";
import { BillsService } from "./bills.service.js";
import { MeteringService } from "./metering.service.js";
import { BillingController } from "./billing.controller.js";
@Module({
  providers: [BillsService, MeteringService],
  controllers: [BillingController],
})
export class BillingModule {}
