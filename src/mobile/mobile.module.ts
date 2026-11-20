import { Module } from '@nestjs/common';
import { MobileController } from './mobile.controller.js';
import { MobileService } from './mobile.service.js';
import { MobileGuard } from './mobile.guard.js';
import { PropertiesService } from '../properties/properties.service.js';
import { MeterInstallationsService } from '../properties/meter-installations.service.js';
import { PeopleService } from '../people/people.service.js';
import { TenancyService } from '../people/tenancy.service.js';
import { BillsService } from '../billing/bills.service.js';
import { MeteringService } from '../billing/metering.service.js';
import { CollectionsService } from '../collections/collections.service.js';
import { MobileRentService } from './mobile-rent.service.js';
import { MobileRentCronController } from './mobile-rent-cron.controller.js';

/** Isolated mobile API. No existing admin-web controller or service is modified. */
@Module({
  controllers: [MobileController, MobileRentCronController],
  providers: [MobileService, MobileGuard, PropertiesService, MeterInstallationsService,
    PeopleService, TenancyService, BillsService, MeteringService, CollectionsService, MobileRentService],
})
export class MobileModule {}
