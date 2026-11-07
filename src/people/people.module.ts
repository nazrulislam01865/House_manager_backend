import { Module } from "@nestjs/common";
import { PeopleController } from "./people.controller.js";
import { PeopleService } from "./people.service.js";
import { TenancyService } from "./tenancy.service.js";
@Module({
  controllers: [PeopleController],
  providers: [PeopleService, TenancyService],
})
export class PeopleModule {}
