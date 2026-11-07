import { Module } from "@nestjs/common";
import { ReportingController } from "./reporting.controller.js";
import { ReportingService } from "./reporting.service.js";
@Module({ providers: [ReportingService], controllers: [ReportingController] })
export class ReportingModule {}
