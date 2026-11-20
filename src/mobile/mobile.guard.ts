import { CanActivate, ExecutionContext, Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { MobileService } from './mobile.service.js';

@Injectable()
export class MobileGuard implements CanActivate {
  constructor(@Inject(MobileService) private mobile: MobileService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const bearer = /^Bearer ([a-f0-9]{64})$/.exec(request.get('authorization') || '');
    if (!bearer) throw new UnauthorizedException('Sign in to continue');
    request.mobileActor = await this.mobile.session(bearer[1]);
    return true;
  }
}
