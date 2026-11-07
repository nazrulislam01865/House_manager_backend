import { MeterInstallationsService } from "./meter-installations.service.js";
import { Module } from "@nestjs/common";
import { PropertiesController } from "./properties.controller.js";
import { PropertiesService } from "./properties.service.js";
@Module({
  controllers: [PropertiesController],
  providers: [PropertiesService, MeterInstallationsService],
})
export class PropertiesModule {}
