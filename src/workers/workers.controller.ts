import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { WorkersService } from './workers.service';
import { SmartAllocatorService } from './smart-allocator.service';
import { JwtAuthGuard, RolesGuard, MachineAuthGuard, RateLimiterGuard } from '../common/guards';
import { CurrentUser, CurrentMachine, Roles, Throttle } from '../common/decorators';
import {
  RegisterMachineDto,
  PairMachineDto,
  HeartbeatDto,
  UpdateJobStatusDto,
  ReportJobResultDto,
  CreateWorkerDto,
  AdminWorkerActionDto,
  ActivityLogQueryDto,
  UpdateWorkerCapacityDto,
  AllocationQueryDto,
  FailJobDto,
  RecordPollEventsBatchDto,
  WorkerStopDto,
} from './dto/worker.dto';
import { AuthorizePaymentDto } from './dto/authorize-payment.dto';
import { Role } from '@prisma/client';

@Controller('workers')
export class WorkersController {
  constructor(
    private readonly workersService: WorkersService,
    private readonly smartAllocator: SmartAllocatorService,
  ) {}

  /**
   * Worker initial boot: Register & get pairing code
   */
  @Post('register')
  @UseGuards(RateLimiterGuard)
  @Throttle(10, 60)
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
   * Super Admin initiates new worker registration directly
   */
  @Post('admin/create')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async adminCreateWorker(@Body() dto: CreateWorkerDto, @CurrentUser() admin: any) {
    return this.workersService.adminCreateWorker(dto, admin);
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
   * Admin retrieves fleet real-time summary statistics
   */
  @Get('summary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async getFleetSummary() {
    return this.workersService.getFleetSummary();
  }

  /**
   * Super Admin retrieves detailed queue health, allocator status & worker execution diagnostics
   */
  @Get('diagnostics/queue-health')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async getQueueAndWorkerDiagnostics() {
    return this.workersService.getQueueAndWorkerDiagnostics();
  }

  /**
   * Admin retrieves fleet-wide activity logs
   */
  @Get('logs/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async getFleetActivityLogs(@Query() query: ActivityLogQueryDto) {
    return this.workersService.getFleetActivityLogs(query);
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
   * Super Admin retrieves smart job allocation logs & history
   */
  @Get('allocations')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async getAllocationHistory(@Query() query: AllocationQueryDto) {
    return this.smartAllocator.getAllocationHistory(query);
  }

  /**
   * Super Admin triggers manual allocation sweep across eligible pending jobs
   */
  @Post('allocations/sweep')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async runAllocationSweep() {
    return this.smartAllocator.runAllocationSweep();
  }

  /**
   * Super Admin triggers stale reservation and expired lease recovery
   */
  @Post('allocations/recover-stale')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async recoverStaleAllocations() {
    return this.smartAllocator.recoverStaleLeases();
  }

  /**
   * Date-First Discovery: retrieves unique dates with pending bookings.
   * Registered BEFORE parameterized route ':id' so Express does not intercept it.
   */
  @Get('pending-dates')
  @UseGuards(MachineAuthGuard)
  async getPendingDates(@CurrentMachine() machine: any) {
    if (!machine || !machine.id) {
      throw new UnauthorizedException('Valid worker machine authentication is required to access pending dates');
    }
    return this.workersService.getPendingDates(machine.id);
  }

  /**
   * Watchlist: View all actively watched dates.
   * Registered BEFORE parameterized route ':id' so Express does not intercept it.
   */
  @Get('watchlist')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.CENTRE)
  async getWatchlist() {
    return this.workersService.getWatchlist();
  }

  /**
   * Admin retrieves single worker details
   */
  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async getWorkerById(@Param('id') id: string) {
    return this.workersService.getWorkerById(id);
  }

  /**
   * Super Admin updates worker capacity, deployment configuration, and capabilities
   */
  @Patch(':id/capacity')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async updateWorkerCapacity(
    @Param('id') id: string,
    @Body() dto: UpdateWorkerCapacityDto,
  ) {
    return this.smartAllocator.updateWorkerCapacity(id, dto);
  }

  /**
   * Admin retrieves activity logs for a specific worker
   */
  @Get(':id/logs')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async getWorkerActivityLogs(@Param('id') id: string, @Query() query: ActivityLogQueryDto) {
    return this.workersService.getWorkerActivityLogs(id, query);
  }

  /**
   * Super Admin enables a worker machine
   */
  @Post(':id/enable')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async enableWorker(@Param('id') id: string, @CurrentUser() admin: any) {
    return this.workersService.enableWorker(id, admin);
  }

  /**
   * Super Admin disables a worker machine
   */
  @Post(':id/disable')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async disableWorker(
    @Param('id') id: string,
    @Body() dto: AdminWorkerActionDto,
    @CurrentUser() admin: any,
  ) {
    return this.workersService.disableWorker(id, dto?.reason, admin);
  }

  /**
   * Super Admin pauses worker job assignments
   */
  @Post(':id/pause')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async pauseWorker(
    @Param('id') id: string,
    @Body() dto: AdminWorkerActionDto,
    @CurrentUser() admin: any,
  ) {
    return this.workersService.pauseWorker(id, dto?.reason, admin);
  }

  /**
   * Super Admin sets worker to monitor-only mode
   */
  @Post(':id/monitor-only')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async setMonitorOnly(@Param('id') id: string, @CurrentUser() admin: any) {
    return this.workersService.setMonitorOnly(id, admin);
  }

  /**
   * Super Admin requests graceful shutdown & drain
   */
  @Post(':id/drain')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async drainWorker(@Param('id') id: string, @CurrentUser() admin: any) {
    return this.workersService.drainWorker(id, admin);
  }

  /**
   * Super Admin revokes worker credentials
   */
  @Post(':id/revoke')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async revokeWorker(
    @Param('id') id: string,
    @Body() dto: AdminWorkerActionDto,
    @CurrentUser() admin: any,
  ) {
    return this.workersService.revokeWorker(id, dto.reason || '', admin);
  }

  /**
   * Super Admin retires worker from active fleet
   */
  @Post(':id/retire')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async retireWorker(
    @Param('id') id: string,
    @Body() dto: AdminWorkerActionDto,
    @CurrentUser() admin: any,
  ) {
    return this.workersService.retireWorker(id, dto.reason || '', admin);
  }

  /**
   * Super Admin completely deletes worker and revokes all terminal access
   */
  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async deleteWorker(
    @Param('id') id: string,
    @Body() dto: AdminWorkerActionDto,
    @CurrentUser() admin: any,
  ) {
    return this.workersService.deleteWorker(id, dto?.reason, admin);
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
   * Worker records persistent availability refresh poll events
   */
  @Post('monitoring/poll-events')
  @UseGuards(MachineAuthGuard)
  async recordPollEvents(
    @CurrentMachine() machine: any,
    @Body() dto: RecordPollEventsBatchDto,
  ) {
    return this.workersService.recordPollEvents(machine.id, dto);
  }

  /**
   * Worker explicit graceful shutdown notification
   */
  @Post('stop')
  @UseGuards(MachineAuthGuard)
  async handleWorkerStop(
    @CurrentMachine() machine: any,
    @Body() dto: WorkerStopDto,
  ) {
    return this.workersService.handleWorkerStop(machine.id, dto);
  }

  /**
   * Worker claims next eligible job
   */
  @Post('jobs/claim')
  @UseGuards(MachineAuthGuard)
  async claimJob(
    @CurrentMachine() machine: any,
    @Body() dto?: {
      activeJobIds?: string[];
      triggerSource?: 'QUEUE_POLL' | 'SLOT_OPENED' | 'SNIPER';
      date?: string;
      route?: string;
      jobType?: string;
      maxActiveBookings?: number;
    },
  ) {
    return this.workersService.claimJob(machine.id, dto?.activeJobIds, {
      triggerSource: dto?.triggerSource,
      date: dto?.date,
      route: dto?.route,
      jobType: dto?.jobType,
      maxActiveBookings: dto?.maxActiveBookings,
    });
  }

  /**
   * Cancellation Sniping: atomically match and assign the oldest pending booking for a newly available date
   * using FOR UPDATE SKIP LOCKED.
   */
  @Post('match-pending')
  @UseGuards(MachineAuthGuard)
  async matchPending(
    @CurrentMachine() machine: any,
    @Body() dto: { date: string; route?: string; activeJobIds?: string[] },
  ) {
    return this.workersService.matchPendingBooking(machine.id, dto.date, dto.route, dto.activeJobIds);
  }

  /**
   * Watchlist: Admin adds a target date to auto-monitor and snipe
   */
  @Post('watchlist')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.CENTRE)
  async createWatchlist(@Body() dto: { date: string; route?: string }) {
    return this.workersService.createWatchlistEntry(dto.date, dto.route);
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
    @Body() dto: FailJobDto,
  ) {
    return this.workersService.failJob(jobId, machine.id, dto);
  }

  /**
   * Q4/F3: Worker requests authorization before Phase 8 payment click
   */
  @Post('jobs/:id/authorize-payment')
  @UseGuards(MachineAuthGuard)
  async authorizePayment(
    @Param('id') id: string,
    @CurrentMachine() machine: any,
    @Body() dto: AuthorizePaymentDto,
  ) {
    return this.workersService.authorizePayment(id, machine.id, dto);
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
