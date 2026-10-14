import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { WorkersService } from './workers.service';
import { JwtAuthGuard, RolesGuard, MachineAuthGuard } from '../common/guards';
import { CurrentUser, CurrentMachine, Roles } from '../common/decorators';
import {
  RegisterMachineDto,
  PairMachineDto,
  HeartbeatDto,
  UpdateJobStatusDto,
  ReportJobResultDto,
} from './dto/worker.dto';
import { Role } from '@prisma/client';

@Controller('workers')
export class WorkersController {
  constructor(private readonly workersService: WorkersService) {}

  /**
   * Worker initial boot: Register & get pairing code
   */
  @Post('register')
  async registerMachine(@Body() dto: RegisterMachineDto) {
    return this.workersService.registerMachine(dto);
  }

  /**
   * Worker polls if admin has approved pairing code
   */
  @Get('status/:machineCode')
  async checkPairingStatus(@Param('machineCode') machineCode: string) {
    return this.workersService.checkPairingStatus(machineCode);
  }

  /**
   * Admin approves worker pairing
   */
  @Post('pair')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async approvePairing(@Body() dto: PairMachineDto, @CurrentUser() admin: any) {
    return this.workersService.approvePairing(dto, admin);
  }

  /**
   * Admin lists all workers in fleet
   */
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async getAllWorkers() {
    return this.workersService.getAllWorkers();
  }

  /**
   * Super Admin starts / pushes worker execution
   */
  @Post(':id/start')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async startWorker(@Param('id') id: string, @CurrentUser() admin: any) {
    return this.workersService.startWorker(id, admin);
  }

  /**
   * Super Admin stops worker execution immediately
   */
  @Post(':id/stop')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async stopWorker(@Param('id') id: string, @CurrentUser() admin: any) {
    return this.workersService.stopWorker(id, admin);
  }

  /**
   * Super Admin resumes worker execution
   */
  @Post(':id/resume')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async resumeWorker(@Param('id') id: string, @CurrentUser() admin: any) {
    return this.workersService.resumeWorker(id, admin);
  }

  /**
   * Admin manually triggers stale lease recovery
   */
  @Post('recover-stale')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async recoverStaleLeasedJobs() {
    return this.workersService.recoverStaleLeasedJobs();
  }

  /**
   * Worker Heartbeat
   */
  @Post('heartbeat')
  @UseGuards(MachineAuthGuard)
  async handleHeartbeat(@CurrentMachine() machine: any, @Body() dto: HeartbeatDto) {
    return this.workersService.handleHeartbeat(machine.id, dto);
  }

  /**
   * Worker claims next eligible job
   */
  @Post('jobs/claim')
  @UseGuards(MachineAuthGuard)
  async claimJob(@CurrentMachine() machine: any) {
    return this.workersService.claimJob(machine.id);
  }

  /**
   * Worker reports granular Playwright progress update
   */
  @Post('jobs/:id/progress')
  @UseGuards(MachineAuthGuard)
  async updateJobProgress(
    @Param('id') jobId: string,
    @CurrentMachine() machine: any,
    @Body() dto: { status: any; logs?: any; note?: string },
  ) {
    return this.workersService.updateJobProgress(jobId, machine.id, dto);
  }

  /**
   * Worker reports completed job with verified reference
   */
  @Post('jobs/:id/complete')
  @UseGuards(MachineAuthGuard)
  async completeJob(
    @Param('id') jobId: string,
    @CurrentMachine() machine: any,
    @Body() dto: { officialReference?: string; confirmationData?: any; note?: string },
  ) {
    return this.workersService.completeJob(jobId, machine.id, dto);
  }

  /**
   * Worker reports job failure or verification challenge
   */
  @Post('jobs/:id/fail')
  @UseGuards(MachineAuthGuard)
  async failJob(
    @Param('id') jobId: string,
    @CurrentMachine() machine: any,
    @Body() dto: { status: any; errorCode?: string; errorMessage?: string },
  ) {
    return this.workersService.failJob(jobId, machine.id, dto);
  }

  /**
   * Worker renews active lease
   */
  @Post('jobs/:id/lease-renewal')
  @UseGuards(MachineAuthGuard)
  async renewLease(@Param('id') bookingId: string, @CurrentMachine() machine: any) {
    return this.workersService.renewLease(bookingId, machine.id);
  }

  /**
   * Worker reports intermediate status (legacy alias)
   */
  @Post('jobs/:id/status')
  @UseGuards(MachineAuthGuard)
  async updateJobStatus(
    @Param('id') bookingId: string,
    @CurrentMachine() machine: any,
    @Body() dto: UpdateJobStatusDto,
  ) {
    return this.workersService.updateJobStatus(bookingId, machine.id, dto);
  }

  /**
   * Worker reports terminal result (legacy alias)
   */
  @Post('jobs/:id/result')
  @UseGuards(MachineAuthGuard)
  async reportJobResult(
    @Param('id') bookingId: string,
    @CurrentMachine() machine: any,
    @Body() dto: ReportJobResultDto,
  ) {
    return this.workersService.reportJobResult(bookingId, machine.id, dto);
  }
}
