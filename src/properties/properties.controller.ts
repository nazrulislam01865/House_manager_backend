import { BodyDoc } from "../common/api-body.js";
import { MeterInstallationsService } from "./meter-installations.service.js";
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Inject,
  ParseUUIDPipe,
} from "@nestjs/common";
import { z } from "zod";
import { PropertiesService } from "./properties.service.js";
import { AdminGuard } from "../auth/auth.guard.js";
import { Current, type Actor } from "../common/context.js";
import { Validate, listQuery, type ListQuery } from "../common/validation.js";
import * as s from "./properties.schemas.js";
@Controller()
@UseGuards(AdminGuard)
export class PropertiesController {
  constructor(
    @Inject(PropertiesService) private service: PropertiesService,
    @Inject(MeterInstallationsService)
    private meters: MeterInstallationsService,
  ) {}
  @BodyDoc(s.meterInput)
  @Post("rooms/:id/meter-installations")
  link(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(s.meterInput)) d: z.infer<typeof s.meterInput>,
  ) {
    return this.meters.link(a, id, d);
  }
  @BodyDoc(s.meterInput)
  @Post("meter-installations/:id/replace")
  replace(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(s.meterInput)) d: z.infer<typeof s.meterInput>,
  ) {
    return this.meters.replace(a, id, d);
  }
  @Get("houses") list(
    @Current() a: Actor,
    @Query(new Validate(listQuery)) q: ListQuery,
  ) {
    return this.service.list(a, q);
  }
  @Get("houses/:id") detail(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.service.detail(a, id);
  }
  @BodyDoc(s.houseInput)
  @Post("houses")
  create(
    @Current() a: Actor,
    @Body(new Validate(s.houseInput)) d: z.infer<typeof s.houseInput>,
  ) {
    return this.service.create(a, d);
  }
  @BodyDoc(s.houseEdit)
  @Patch("houses/:id")
  edit(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(s.houseEdit)) d: z.infer<typeof s.houseEdit>,
  ) {
    return this.service.edit(a, id, d);
  }
  @BodyDoc(s.assignmentInput)
  @Post("houses/:id/assignments")
  assign(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(s.assignmentInput)) d: z.infer<typeof s.assignmentInput>,
  ) {
    return this.service.changeAssignments(a, id, d);
  }
  @BodyDoc(s.actionInput)
  @Post("houses/:id/archive")
  archive(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(s.actionInput)) d: z.infer<typeof s.actionInput>,
  ) {
    return this.service.remove(a, id, d.version, true);
  }
  @BodyDoc(s.actionInput)
  @Delete("houses/:id")
  remove(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(s.actionInput)) d: z.infer<typeof s.actionInput>,
  ) {
    return this.service.remove(a, id, d.version, false);
  }
  @Get("rooms") rooms(
    @Current() a: Actor,
    @Query(new Validate(listQuery)) q: ListQuery,
  ) {
    return this.service.rooms(a, q);
  }
  @BodyDoc(s.roomInput)
  @Post("rooms")
  room(
    @Current() a: Actor,
    @Body(new Validate(s.roomInput)) d: z.infer<typeof s.roomInput>,
  ) {
    return this.service.addRoom(a, d);
  }
  @BodyDoc(s.roomEdit)
  @Patch("rooms/:id")
  editRoom(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(s.roomEdit)) d: z.infer<typeof s.roomEdit>,
  ) {
    return this.service.editRoom(a, id, d);
  }
  @BodyDoc(s.actionInput)
  @Delete("rooms/:id")
  deleteRoom(
    @Current() a: Actor,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new Validate(s.actionInput)) d: z.infer<typeof s.actionInput>,
  ) {
    return this.service.deleteRoom(a, id, d.version);
  }
}
