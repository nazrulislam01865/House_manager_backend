import { Module } from "@nestjs/common";
import { CollectionsController } from "./collections.controller.js";
import { CollectionsService } from "./collections.service.js";
@Module({
  providers: [CollectionsService],
  controllers: [CollectionsController],
})
export class CollectionsModule {}
