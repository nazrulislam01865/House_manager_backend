import { createObserveModule } from "@nestjs/observe";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DatabaseModule } from "./database/database.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { PropertiesModule } from "./properties/properties.module.js";
import { PeopleModule } from "./people/people.module.js";
import { BillingModule } from "./billing/billing.module.js";
import { CollectionsModule } from "./collections/collections.module.js";
import { ReportingModule } from "./reporting/reporting.module.js";
export const { ObserveModule, ObserveInstrument } = createObserveModule();
const observe =
  process.env.OBSERVE_APP_KEY && process.env.OBSERVE_APP_SECRET
    ? [
        ObserveModule.forRoot({
          appKey: process.env.OBSERVE_APP_KEY,
          appSecret: process.env.OBSERVE_APP_SECRET,
          serviceId: "houseledger-api",
        }),
      ]
    : [];
@Module({
  imports: [
    ...observe,
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    PropertiesModule,
    PeopleModule,
    BillingModule,
    CollectionsModule,
    ReportingModule,
  ],
})
export class AppModule {}
