import { Controller, Get, Headers, Inject, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { MobileRentService } from './mobile-rent.service.js';

/** Vercel cron invokes this with Authorization: Bearer <CRON_SECRET>.
 * No account login or public access to this endpoint is permitted.
 */
@Controller('mobile/jobs')
export class MobileRentCronController {
  constructor(@Inject(MobileRentService) private readonly rent: MobileRentService) {}

  @Get('rent')
  run(@Headers('authorization') authorization?: string) {
    const secret = process.env.CRON_SECRET;
    if (!secret || secret.length < 20 || !authorization?.startsWith('Bearer '))
      throw new UnauthorizedException();
    const supplied = Buffer.from(authorization.substring(7));
    const expected = Buffer.from(secret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied,expected))
      throw new UnauthorizedException();
    return this.rent.runMonthlyRent();
  }
}
