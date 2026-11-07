import { Global, Module } from "@nestjs/common";
import { Database } from "./database.service.js";
@Global()
@Module({ providers: [Database], exports: [Database] })
export class DatabaseModule {}
