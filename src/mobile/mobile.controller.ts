import { Controller, Post, Get, Patch, Delete, Body, Param, Req, Headers, UseGuards, Inject, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Validate, id, date, month, text, minor } from '../common/validation.js';
import { MobileGuard } from './mobile.guard.js';
import { MobileService, type MobileActor } from './mobile.service.js';
import { MobileRentService } from './mobile-rent.service.js';
import { MobileElectricityService } from './mobile-electricity.service.js';
import { MobileStatementsService } from './mobile-statements.service.js';
import { monthlyStatementXlsx, managerFullReportXlsx } from './monthly-statement-xlsx.js';
import { MobileManagerReportService } from './mobile-manager-report.service.js';

type AuthenticatedRequest = Request & { mobileActor: MobileActor };
const monthlyStatementQuery = z.object({houseId:id,month}).strict();
const managerReportQuery = z.object({houseId:id.optional(),month}).strict();
const credentials = z.object({ identifier: z.string().trim().min(3).max(100), password: z.string().min(1).max(200) }).strict();
const room = z.object({ houseId: id, number: text, rentMinor: minor, meter: z.string().trim().max(80).optional(), initialReading: z.string().regex(/^\d{1,10}(\.\d{1,3})?$/).optional(), installedAt: date.optional() }).strict();
const editRoom = z.object({ number: text, rentMinor: minor, effectiveMonth: month }).strict();
const resident = z.object({ roomId: id, name: text, phone: z.string().regex(/^01[3-9]\d{8}$/), startDate: date, rentMinor: minor }).strict();
const editResident = z.object({ name: text, phone: z.string().regex(/^01[3-9]\d{8}$/) }).strict();
const move = z.object({ roomId: id, effectiveDate: date, rentMinor: minor }).strict();
const end = z.object({ endDate: date }).strict();
const reading = z.object({ roomId: id, month, readAt: date, current: z.string().regex(/^\d{1,10}(\.\d{1,3})?$/) }).strict();
const opening = reading.omit({month:true});
const rate = z.object({ houseId: id, effectiveFrom: date, rate: z.string().regex(/^\d{1,8}(\.\d{1,4})?$/) }).strict();
const replaceMeter = z.object({ serial: text, installedAt: date, baseline: z.string().regex(/^\d{1,10}(\.\d{1,3})?$/) }).strict();
const payment = z.object({ billId: id, amountMinor: minor, method: z.enum(['Cash','Bank transfer','bKash','Nagad']), receivedAt: date }).strict();
const rentCollect = z.object({ roomId: id, month, amountMinor: minor, method: z.enum(['Cash','Bank transfer','bKash','Nagad']), receivedAt: date }).strict();
const rentRun = z.object({ houseId: id, month, dueDay: z.number().int().min(1).max(28) }).strict();
const profile = z.object({ name: text, phone: z.string().regex(/^01[3-9]\d{8}$/).optional(), email: z.email().max(200).nullable().optional() }).strict();
const password = z.object({ password: z.string().min(8).max(128) }).strict();

@Controller('mobile')
export class MobileController {
  constructor(@Inject(MobileService) private mobile: MobileService, @Inject(MobileRentService) private mobileRent: MobileRentService, @Inject(MobileElectricityService) private mobileElectricity: MobileElectricityService, @Inject(MobileStatementsService) private statements:MobileStatementsService, @Inject(MobileManagerReportService) private managerReports:MobileManagerReportService) {}
  @Post('auth/login') login(@Body(new Validate(credentials)) d: z.infer<typeof credentials>, @Req() req: Request) { return this.mobile.login(d.identifier,d.password,req.ip || 'unknown'); }
  @UseGuards(MobileGuard) @Get('auth/me') me(@Req() req: AuthenticatedRequest) { return this.mobile.me(req.mobileActor); }
  @UseGuards(MobileGuard) @Post('auth/logout') logout(@Req() req: AuthenticatedRequest) { return this.mobile.logout(req.mobileActor); }
  @UseGuards(MobileGuard) @Get('bootstrap') bootstrap(@Req() req: AuthenticatedRequest) { return this.mobile.bootstrap(req.mobileActor); }
  @UseGuards(MobileGuard) @Get('statements') statement(@Req() req:AuthenticatedRequest,
    @Query(new Validate(monthlyStatementQuery)) q:z.infer<typeof monthlyStatementQuery>) {
    return this.statements.monthly(req.mobileActor,q.month,q.houseId);
  }
  @UseGuards(MobileGuard) @Get('statements/export') async exportStatement(@Req() req:AuthenticatedRequest,
    @Query(new Validate(monthlyStatementQuery)) q:z.infer<typeof monthlyStatementQuery>,@Res() res:Response) {
    const report=await this.statements.monthly(req.mobileActor,q.month,q.houseId);
    const workbook=monthlyStatementXlsx(report);
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="HouseLedger-${q.month}-statement.xlsx"`);
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.end(workbook);
  }

  @UseGuards(MobileGuard) @Get('reports/full') fullReport(@Req() req:AuthenticatedRequest,
    @Query(new Validate(managerReportQuery)) q:z.infer<typeof managerReportQuery>) {
    return this.managerReports.full(req.mobileActor,q.month,q.houseId);
  }
  @UseGuards(MobileGuard) @Get('reports/full/export') async exportFullReport(@Req() req:AuthenticatedRequest,
    @Query(new Validate(managerReportQuery)) q:z.infer<typeof managerReportQuery>,@Res() res:Response) {
    const report=await this.managerReports.full(req.mobileActor,q.month,q.houseId);
    const workbook=managerFullReportXlsx(report);
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="HouseLedger-Manager-Full-Report-${q.month}.xlsx"`);
    res.setHeader('Cache-Control','private, no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.end(workbook);
  }

  @UseGuards(MobileGuard) @Patch('profile') updateProfile(@Req() req: AuthenticatedRequest, @Body(new Validate(profile)) d: z.infer<typeof profile>) { return this.mobile.updateProfile(req.mobileActor,d); }
  @UseGuards(MobileGuard) @Post('rooms') createRoom(@Req() req: AuthenticatedRequest, @Body(new Validate(room)) d: z.infer<typeof room>) { return this.mobile.createRoom(req.mobileActor,d); }
  @UseGuards(MobileGuard) @Patch('rooms/:id') updateRoom(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) roomId: string, @Body(new Validate(editRoom)) d: z.infer<typeof editRoom>) { return this.mobile.updateRoom(req.mobileActor,roomId,d); }
  @UseGuards(MobileGuard) @Delete('rooms/:id') removeRoom(@Req() req: AuthenticatedRequest, @Param('id',ParseUUIDPipe) roomId: string) { return this.mobile.removeRoom(req.mobileActor,roomId); }
  @UseGuards(MobileGuard) @Post('rooms/:id/replace-meter') meter(@Req() req: AuthenticatedRequest, @Param('id',ParseUUIDPipe) roomId: string, @Body(new Validate(replaceMeter)) d: z.infer<typeof replaceMeter>) { return this.mobile.replaceMeter(req.mobileActor,roomId,d); }
  @UseGuards(MobileGuard) @Post('residents') createResident(@Req() req: AuthenticatedRequest, @Body(new Validate(resident)) d: z.infer<typeof resident>) { return this.mobile.createResident(req.mobileActor,d); }
  @UseGuards(MobileGuard) @Patch('residents/:id') updateResident(@Req() req: AuthenticatedRequest, @Param('id',ParseUUIDPipe) residentId: string, @Body(new Validate(editResident)) d: z.infer<typeof editResident>) { return this.mobile.updateResident(req.mobileActor,residentId,d); }
  @UseGuards(MobileGuard) @Post('residents/:id/end') endResident(@Req() req: AuthenticatedRequest, @Param('id',ParseUUIDPipe) residentId: string, @Body(new Validate(end)) d: z.infer<typeof end>) { return this.mobile.endResident(req.mobileActor,residentId,d); }
  @UseGuards(MobileGuard) @Post('residents/:id/move') moveResident(@Req() req: AuthenticatedRequest, @Param('id',ParseUUIDPipe) residentId: string, @Body(new Validate(move)) d: z.infer<typeof move>) { return this.mobile.moveResident(req.mobileActor,residentId,d); }
  @UseGuards(MobileGuard) @Post('residents/:id/set-password') setPassword(@Req() req: AuthenticatedRequest, @Param('id',ParseUUIDPipe) residentId: string, @Body(new Validate(password)) d: z.infer<typeof password>) { return this.mobile.setResidentPassword(req.mobileActor,residentId,d.password); }
  @UseGuards(MobileGuard) @Post('rent/collect') collectRent(@Req() req: AuthenticatedRequest, @Body(new Validate(rentCollect)) d: z.infer<typeof rentCollect>, @Headers('idempotency-key') key: string) { return this.mobileRent.collect(req.mobileActor,d,key); }
  @UseGuards(MobileGuard) @Post('rent/generate') generateRent(@Req() req: AuthenticatedRequest, @Body(new Validate(rentRun)) d: z.infer<typeof rentRun>, @Headers('idempotency-key') key: string) { return this.mobile.generateRent(req.mobileActor,d,key); }
  @UseGuards(MobileGuard) @Post('electricity/handover') handover(@Req() req:AuthenticatedRequest, @Body(new Validate(opening)) d:z.infer<typeof opening>, @Headers('idempotency-key') key:string) {return this.mobileElectricity.handover(req.mobileActor,d,key);}
  @UseGuards(MobileGuard) @Post('electricity/preview') preview(@Req() req: AuthenticatedRequest, @Body(new Validate(reading)) d: z.infer<typeof reading>) { return this.mobile.previewElectricity(req.mobileActor,d); }
  @UseGuards(MobileGuard) @Post('electricity/issue') issue(@Req() req: AuthenticatedRequest, @Body(new Validate(reading)) d: z.infer<typeof reading>, @Headers('idempotency-key') key: string) { return this.mobile.issueElectricity(req.mobileActor,d,key); }
  @UseGuards(MobileGuard) @Post('electricity/rates') saveRate(@Req() req: AuthenticatedRequest, @Body(new Validate(rate)) d: z.infer<typeof rate>) { return this.mobile.saveRate(req.mobileActor,d); }
  @UseGuards(MobileGuard) @Post('electricity/collect') collectElectricity(@Req() req: AuthenticatedRequest, @Body(new Validate(rentCollect)) d: z.infer<typeof rentCollect>, @Headers('idempotency-key') key: string) { return this.mobileElectricity.collect(req.mobileActor,d,key); }
  @UseGuards(MobileGuard) @Post('payments') recordPayment(@Req() req: AuthenticatedRequest, @Body(new Validate(payment)) d: z.infer<typeof payment>, @Headers('idempotency-key') key: string) { return this.mobile.payment(req.mobileActor,d,key); }
}
