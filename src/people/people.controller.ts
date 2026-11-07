import { BodyDoc } from "../common/api-body.js";
import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Inject,
  ParseUUIDPipe,
} from "@nestjs/common";
import { z } from "zod";
import { PeopleService } from "./people.service.js";
import { TenancyService } from "./tenancy.service.js";
import { AdminGuard } from "../auth/auth.guard.js";
import { Current, type Actor } from "../common/context.js";
import { Validate, listQuery, type ListQuery } from "../common/validation.js";
import * as s from "./people.schemas.js";
@Controller()
@UseGuards(AdminGuard)
export class PeopleController {
  constructor(
    @Inject(PeopleService) private people: PeopleService,
    @Inject(TenancyService) private tenancies: TenancyService,
  ) {}
  @Get("managers") managers(
    @Current() a: Actor,
    @Query(new Validate(listQuery)) q: ListQuery,
  ) {
    return this.people.managers(a, q);
  }
  @BodyDoc(s.managerInput)
  @Post("managers")
  manager(
    @Current() a: Actor,
    @Body(new Validate(s.managerInput)) d: z.infer<typeof s.managerInput>,
  ) {
    return this.people.addManager(a, d);
  }
  @BodyDoc(s.managerEdit)
  @Patch("managers/:id")
  editManager(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(s.managerEdit)) d: z.infer<typeof s.managerEdit>,
  ) {
    return this.people.editManager(a, id, d);
  }
  @Get("residents") residents(
    @Current() a: Actor,
    @Query(new Validate(listQuery)) q: ListQuery,
  ) {
    return this.people.residents(a, q);
  }
  @BodyDoc(s.residentInput)
  @Post("residents")
  resident(
    @Current() a: Actor,
    @Body(new Validate(s.residentInput)) d: z.infer<typeof s.residentInput>,
  ) {
    return this.people.addResident(a, d);
  }
  @BodyDoc(s.residentEdit)
  @Patch("residents/:id")
  editResident(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(s.residentEdit)) d: z.infer<typeof s.residentEdit>,
  ) {
    return this.people.editResident(a, id, d);
  }
  @BodyDoc(s.endInput)
  @BodyDoc(s.allocationInput)
  @Post("tenancies")
  allocate(
    @Current() a: Actor,
    @Body(new Validate(s.allocationInput)) d: z.infer<typeof s.allocationInput>,
  ) {
    return this.tenancies.reallocate(a, d);
  }
  @Post("tenancies/:id/end")
  end(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(s.endInput)) d: z.infer<typeof s.endInput>,
  ) {
    return this.tenancies.end(a, id, d);
  }
  @BodyDoc(s.moveInput)
  @Post("tenancies/:id/move")
  move(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(s.moveInput)) d: z.infer<typeof s.moveInput>,
  ) {
    return this.tenancies.move(a, id, d);
  }
  @BodyDoc(s.termsInput)
  @Post("tenancies/:id/rent-terms")
  terms(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(s.termsInput)) d: z.infer<typeof s.termsInput>,
  ) {
    return this.tenancies.rentTerms(a, id, d);
  }
}
