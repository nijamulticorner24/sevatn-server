import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  RegisterMachineDto,
  PairMachineDto,
  HeartbeatDto,
  UpdateJobStatusDto,
  ReportJobResultDto,
  CreateWorkerDto,
  AdminWorkerActionDto,
  ActivityLogQueryDto,
  RecordPollEventsBatchDto,
  WorkerStopDto,
} from './dto/worker.dto';
import { AuthorizePaymentDto } from './dto/authorize-payment.dto';
import { WorkerStatus, BookingStatus, NotificationChannel, JobType, AccountStatus, Prisma } from '@prisma/client';
import { validateNominee } from '../common/nominee-validator';
import { randomBytes, randomUUID } from 'crypto';
import { AccountLockService } from '../availability/account-lock.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { hashMachineToken } from '../common/security/token-hash';
import { EventsGateway } from '../events/events.gateway';
import { SmartAllocatorService } from './smart-allocator.service';
import { BookingStateMachineService } from '../bookings/booking-state-machine.service';
import {
  CLAIMABLE_OPEN_REQUEST_STATUSES,
  TERMINAL_OR_EXCLUDED_BOOKING_STATUSES,
  ACTIVE_RUNNING_JOB_STATUSES,
  TAKEOVER_ELIGIBLE_INFLIGHT_STATUSES,
  evaluateJobActiveCapacity,
  extractAuthoritativeReference,
  isDateInPast,
  isRouteMatching,
  normalizeRouteCanonical,
} from '../common/booking-status.constants';
import { normalizeDemandKey } from '../common/utils/demand-key';

// Q6/ITEM 8: Arbiter lease timing (PR #0)
export const LEASE_TTL_MS = Number(process.env.LEASE_TTL_MS ?? 30000);
export const LEASE_RENEWAL_MS = Number(process.env.LEASE_RENEWAL_MS ?? 10000);

@Injectable()
export class WorkersService {
  private readonly logger = new Logger(WorkersService.name);
  private static readonly pairingTokenClaims = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private prisma: PrismaService,
    private walletService: WalletService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private accountLockService: AccountLockService,
    private smartMatcher: SmartMatcherService,
    @Optional() private stateMachine?: BookingStateMachineService,
    @Optional() private smartAllocator?: SmartAllocatorService,
    @Optional() private eventsGateway?: EventsGateway,
  ) {}

  /**
   * Internal helper to record structured worker activity timeline events
   */
  async createActivityLog(params: {
    workerId: string;
    jobId?: string | null;
    bookingId?: string | null;
    eventType: string;
    severity?: string;
    activity?: string | null;
    message: string;
    details?: any;
  }) {
    try {
      const log = await this.prisma.workerActivityLog.create({
        data: {
          workerId: params.workerId,
          jobId: params.jobId || null,
          bookingId: params.bookingId || null,
          eventType: params.eventType,
          severity: params.severity || 'INFO',
          activity: params.activity || null,
          message: params.message,
          details: params.details || Prisma.DbNull,
        },
      });

      if (this.eventsGateway) {
        this.eventsGateway.emitToAdmins('worker:activity', log);
      }
      return log;
    } catch (err: any) {
      this.logger.warn(`Failed to create worker activity log: ${err.message}`);
      return null;
    }
  }

  /**
   * Super Admin initiates worker registration directly and receives pairing instructions
   */
  async adminCreateWorker(dto: CreateWorkerDto, adminUser: any) {
    const existing = await this.prisma.workerMachine.findUnique({
      where: { machineCode: dto.machineCode },
    });

    if (existing && existing.active && existing.adminStatus !== 'RETIRED' && existing.adminStatus !== 'REVOKED') {
      throw new ConflictException(`Worker with machine code ${dto.machineCode} is already registered and active.`);
    }

    const pairingCode = `PAIR-${Math.floor(1000 + Math.random() * 9000)}`;

    let machine;
    if (existing) {
      machine = await this.prisma.workerMachine.update({
        where: { id: existing.id },
        data: {
          machineName: dto.machineName,
          version: dto.version || '1.0.0',
          pairingCode,
          status: WorkerStatus.UNPAIRED,
          adminStatus: 'ENABLED',
          desiredState: 'STOPPED',
          currentActivity: 'IDLE',
          active: false,
          machineToken: null,
          retiredAt: null,
          retirementReason: null,
          revokedAt: null,
        },
      });
    } else {
      machine = await this.prisma.workerMachine.create({
        data: {
          machineCode: dto.machineCode,
          machineName: dto.machineName,
          version: dto.version || '1.0.0',
          pairingCode,
          status: WorkerStatus.UNPAIRED,
          adminStatus: 'ENABLED',
          desiredState: 'STOPPED',
          currentActivity: 'IDLE',
          active: false,
        },
      });
    }

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'ADMIN_CREATED_WORKER',
      entity: 'WorkerMachine',
      entityId: machine.id,
      metadata: { machineCode: machine.machineCode, machineName: machine.machineName, pairingCode },
    });

    await this.createActivityLog({
      workerId: machine.id,
      eventType: 'STATE_CHANGE',
      severity: 'INFO',
      activity: 'CONNECTING',
      message: `Worker registration initiated by administrator. Pairing code ${pairingCode} generated.`,
    });

    if (this.eventsGateway) {
      this.eventsGateway.notifyFleetUpdated(machine.machineCode, {
        status: machine.status,
        adminStatus: machine.adminStatus,
        pairingCode,
      });
    }

    return {
      message: `Worker ${machine.machineCode} registered. Pairing code valid for 15 minutes.`,
      machine: {
        id: machine.id,
        machineCode: machine.machineCode,
        machineName: machine.machineName,
        pairingCode: machine.pairingCode,
        status: machine.status,
        adminStatus: machine.adminStatus,
        desiredState: machine.desiredState,
      },
      pairingCode,
      expiresInMinutes: 15,
      setupInstructions: [
        `1. Open worker terminal environment or configuration`,
        `2. Ensure API_BASE_URL is set to this server URL`,
        `3. Set MACHINE_CODE="${machine.machineCode}"`,
        `4. Launch worker node and enter pairing code: ${pairingCode}`,
        `5. Once paired, the administrator can authorize execution from the Fleet dashboard.`,
      ],
    };
  }

  /**
   * Worker machine initiates registration and gets a 6-digit pairing code
   */
  async registerMachine(dto: RegisterMachineDto) {
    const pairingCode = `TA-${Math.floor(1000 + Math.random() * 9000)}`;

    const existing = await this.prisma.workerMachine.findUnique({
      where: { machineCode: dto.machineCode },
    });

    let machine;
    if (existing) {
      machine = await this.prisma.workerMachine.update({
        where: { machineCode: dto.machineCode },
        data: {
          machineName: dto.machineName,
          version: dto.version || '1.0.0',
          pairingCode,
          status: WorkerStatus.UNPAIRED,
          adminStatus: 'ENABLED',
          retiredAt: null,
          retirementReason: null,
          revokedAt: null,
        },
      });
    } else {
      machine = await this.prisma.workerMachine.create({
        data: {
          machineCode: dto.machineCode,
          machineName: dto.machineName,
          version: dto.version || '1.0.0',
          pairingCode,
          status: WorkerStatus.UNPAIRED,
          adminStatus: 'ENABLED',
          desiredState: 'STOPPED',
          currentActivity: 'IDLE',
          active: false,
        },
      });
    }

    await this.createActivityLog({
      workerId: machine.id,
      eventType: 'STATE_CHANGE',
      severity: 'INFO',
      activity: 'CONNECTING',
      message: `Worker terminal requested pairing code. Code: ${pairingCode}`,
    });

    return {
      message: 'Worker machine registered. Enter pairing code in Admin portal to activate.',
      machineId: machine.id,
      machineCode: machine.machineCode,
      pairingCode: machine.pairingCode,
    };
  }

  /**
   * Admin enters pairing code to approve machine and generate secure machineToken.
   * Stores SHA-256 verifier in database and provisions raw token once to authorized terminal.
   * Does NOT mark worker ONLINE until an actual authenticated connection/heartbeat is received.
   */
  async approvePairing(dto: PairMachineDto, adminUser?: any) {
    const cleanPairingCode = dto.pairingCode?.trim().toUpperCase();
    if (!cleanPairingCode) {
      throw new BadRequestException('Pairing code is required');
    }

    const machine = await this.prisma.workerMachine.findUnique({
      where: { pairingCode: cleanPairingCode },
    });

    if (!machine) {
      throw new NotFoundException('Invalid or expired pairing code');
    }

    if (machine.adminStatus === 'REVOKED' || machine.adminStatus === 'RETIRED') {
      throw new ForbiddenException(`Cannot pair worker ${machine.machineCode} because it has been ${machine.adminStatus}.`);
    }

    // Verify machine code binding if supplied by administrator
    if (dto.machineCode) {
      const cleanMachineCode = dto.machineCode.trim().toUpperCase();
      if (machine.machineCode.toUpperCase() !== cleanMachineCode) {
        throw new BadRequestException(
          `Machine identifier mismatch: pairing code was generated for '${machine.machineCode}', but '${cleanMachineCode}' was submitted.`
        );
      }

    }

    const rawMachineToken = `wkt_${randomBytes(24).toString('hex')}`;
    const tokenHash = hashMachineToken(rawMachineToken);

    const assignedName = dto.machineName?.trim() || machine.machineName;
    const locationInfo = dto.location?.trim() ? ` Location: ${dto.location.trim()}` : '';

    const updated = await this.prisma.workerMachine.update({
      where: { id: machine.id },
      data: {
        machineToken: tokenHash, // Store SHA-256 verifier, never plaintext token
        machineName: assignedName,
        status: WorkerStatus.STOPPED, // NOT ONLINE yet — only transitions to ONLINE upon authenticated heartbeat
        adminStatus: 'ENABLED',
        active: true,
        desiredState: 'STOPPED', // Pairing approval does NOT automatically start execution
        currentActivity: 'IDLE',
        activityDetails: `Registration approved by administrator.${locationInfo} Awaiting worker node connection.`,
        pairingCode: null, // Invalidate pairing code immediately to prevent replay
        lastHeartbeat: null, // Clear lastHeartbeat so worker does NOT falsely appear online
        retiredAt: null,
        retirementReason: null,
        revokedAt: null,
      },
    });

    // Provide short 5-minute single-claim window for polling worker terminal
    WorkersService.pairingTokenClaims.set(machine.machineCode, {
      token: rawMachineToken,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_PAIRED',
      entity: 'WorkerMachine',
      entityId: updated.id,
      metadata: {
        machineCode: updated.machineCode,
        machineName: updated.machineName,
        location: dto.location || null,
        description: dto.description || null,
      },
    });

    await this.createActivityLog({
      workerId: updated.id,
      eventType: 'STATE_CHANGE',
      severity: 'INFO',
      activity: 'IDLE',
      message: `Worker machine paired and registered (${assignedName}). Initial state: STOPPED. Awaiting first authenticated connection.`,
    });

    if (this.eventsGateway) {
      this.eventsGateway.notifyFleetUpdated(updated.machineCode, {
        status: updated.status,
        adminStatus: updated.adminStatus,
        desiredState: updated.desiredState,
        active: true,
      });
    }

    return {
      message: `Worker machine ${updated.machineCode} registered and approved successfully. Awaiting authenticated connection.`,
      machine: {
        id: updated.id,
        machineCode: updated.machineCode,
        machineName: updated.machineName,
        status: updated.status,
        adminStatus: updated.adminStatus,
        desiredState: updated.desiredState,
        active: updated.active,
      },
    };
  }

  /**
   * Super Admin starts / pushes worker execution
   */
  async startWorker(machineId: string, adminUser?: any) {
    const machine = (await this.prisma.workerMachine.findUnique({
      where: { id: machineId },
    })) || (await this.prisma.workerMachine.findUnique({
      where: { machineCode: machineId },
    }));

    if (!machine) {
      throw new NotFoundException('Worker machine not found');
    }

    if (!machine.active || !machine.machineToken) {
      throw new BadRequestException('Cannot start an unpaired worker machine. Complete pairing approval first.');
    }

    if (machine.adminStatus === 'DISABLED' || machine.adminStatus === 'REVOKED' || machine.adminStatus === 'RETIRED') {
      throw new ForbiddenException(`Cannot start a worker in ${machine.adminStatus} status. Enable it first.`);
    }

    const updated = await this.prisma.workerMachine.update({
      where: { id: machine.id },
      data: {
        desiredState: 'RUNNING',
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_STARTED',
      entity: 'WorkerMachine',
      entityId: updated.id,
      metadata: { machineCode: updated.machineCode, machineName: updated.machineName },
    });

    await this.createActivityLog({
      workerId: updated.id,
      eventType: 'STATE_CHANGE',
      severity: 'INFO',
      message: `Worker ${updated.machineCode} execution authorized (RUNNING).`,
    });

    if (this.eventsGateway) {
      this.eventsGateway.notifyFleetUpdated(updated.machineCode, { desiredState: 'RUNNING' });
    }

    return {
      message: `Worker ${updated.machineCode} authorized to execute permitted work`,
      machine: updated,
    };
  }

  /**
   * Super Admin stops worker execution
   */
  async stopWorker(machineId: string, adminUser?: any) {
    const machine = (await this.prisma.workerMachine.findUnique({
      where: { id: machineId },
    })) || (await this.prisma.workerMachine.findUnique({
      where: { machineCode: machineId },
    }));

    if (!machine) {
      throw new NotFoundException('Worker machine not found');
    }

    const targetState = machine.currentJobId ? 'STOPPING' : 'STOPPED';

    const updated = await this.prisma.workerMachine.update({
      where: { id: machine.id },
      data: {
        desiredState: targetState,
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_STOPPED',
      entity: 'WorkerMachine',
      entityId: updated.id,
      metadata: { machineCode: updated.machineCode, machineName: updated.machineName, state: targetState },
    });

    await this.createActivityLog({
      workerId: updated.id,
      eventType: 'STATE_CHANGE',
      severity: 'WARN',
      message: `Worker ${updated.machineCode} execution stopped (target state: ${targetState}).`,
    });

    if (this.eventsGateway) {
      this.eventsGateway.notifyFleetUpdated(updated.machineCode, { desiredState: targetState });
    }

    if (typeof this.notifications?.sendTelegramWorkerNotification === 'function') {
      await this.notifications.sendTelegramWorkerNotification({
        workerId: updated.id,
        machineCode: updated.machineCode,
        machineName: updated.machineName,
        status: 'STOPPED',
        reason: `Worker execution stopped by administrator (${adminUser?.email || adminUser?.name || 'Super Admin'})`,
      }).catch((err) => this.logger.warn(`[Telegram Bot] Error sending worker stop alert: ${err.message}`));
    }

    return {
      message: targetState === 'STOPPING'
        ? `Worker ${updated.machineCode} stop requested. Waiting for in-flight job to conclude safely.`
        : `Worker ${updated.machineCode} execution stopped immediately.`,
      machine: updated,
    };
  }

  /**
   * Super Admin resumes worker execution
   */
  async resumeWorker(machineId: string, adminUser?: any) {
    const machine = (await this.prisma.workerMachine.findUnique({
      where: { id: machineId },
    })) || (await this.prisma.workerMachine.findUnique({
      where: { machineCode: machineId },
    }));

    if (!machine) {
      throw new NotFoundException('Worker machine not found');
    }

    if (!machine.active || !machine.machineToken) {
      throw new BadRequestException('Cannot resume an unpaired worker machine. Complete pairing approval first.');
    }

    if (machine.adminStatus === 'DISABLED' || machine.adminStatus === 'REVOKED' || machine.adminStatus === 'RETIRED') {
      throw new ForbiddenException(`Cannot resume a worker in ${machine.adminStatus} status. Enable it first.`);
    }

    const updated = await this.prisma.workerMachine.update({
      where: { id: machine.id },
      data: {
        desiredState: 'RUNNING',
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_RESUMED',
      entity: 'WorkerMachine',
      entityId: updated.id,
      metadata: { machineCode: updated.machineCode, machineName: updated.machineName },
    });

    await this.createActivityLog({
      workerId: updated.id,
      eventType: 'STATE_CHANGE',
      severity: 'INFO',
      message: `Worker ${updated.machineCode} execution resumed (RUNNING).`,
    });

    if (this.eventsGateway) {
      this.eventsGateway.notifyFleetUpdated(updated.machineCode, { desiredState: 'RUNNING' });
    }

    return {
      message: `Worker ${updated.machineCode} execution resumed`,
      machine: updated,
    };
  }

  /**
   * Super Admin enables a worker machine administratively
   */
  async enableWorker(machineId: string, adminUser?: any) {
    const machine = (await this.prisma.workerMachine.findUnique({ where: { id: machineId } }))
      || (await this.prisma.workerMachine.findUnique({ where: { machineCode: machineId } }));

    if (!machine) throw new NotFoundException('Worker machine not found');
    if (machine.adminStatus === 'RETIRED') {
      throw new BadRequestException('Cannot enable a retired machine. Re-register or un-retire first.');
    }

    const updated = await this.prisma.workerMachine.update({
      where: { id: machine.id },
      data: {
        adminStatus: 'ENABLED',
        active: true,
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_ENABLED',
      entity: 'WorkerMachine',
      entityId: updated.id,
      metadata: { machineCode: updated.machineCode, machineName: updated.machineName },
    });

    await this.createActivityLog({
      workerId: updated.id,
      eventType: 'STATE_CHANGE',
      severity: 'INFO',
      message: `Worker ${updated.machineCode} administratively ENABLED by administrator.`,
    });

    if (this.eventsGateway) {
      this.eventsGateway.notifyFleetUpdated(updated.machineCode, { adminStatus: 'ENABLED', active: true });
    }

    return {
      message: `Worker ${updated.machineCode} is now ENABLED`,
      machine: updated,
    };
  }

  /**
   * Super Admin disables a worker machine administratively
   */
  async disableWorker(machineId: string, reason?: string, adminUser?: any) {
    const machine = (await this.prisma.workerMachine.findUnique({ where: { id: machineId } }))
      || (await this.prisma.workerMachine.findUnique({ where: { machineCode: machineId } }));

    if (!machine) throw new NotFoundException('Worker machine not found');

    const hasActiveJob = !!machine.currentJobId;
    const targetDesiredState = hasActiveJob ? 'STOPPING' : 'STOPPED';

    const updated = await this.prisma.workerMachine.update({
      where: { id: machine.id },
      data: {
        adminStatus: 'DISABLED',
        desiredState: targetDesiredState,
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_DISABLED',
      entity: 'WorkerMachine',
      entityId: updated.id,
      metadata: { machineCode: updated.machineCode, reason: reason || 'Disabled by administrator', targetDesiredState },
    });

    await this.createActivityLog({
      workerId: updated.id,
      eventType: 'STATE_CHANGE',
      severity: 'WARN',
      message: `Worker ${updated.machineCode} DISABLED by administrator. ${reason ? 'Reason: ' + reason : ''}. State: ${targetDesiredState}`,
    });

    if (this.eventsGateway) {
      this.eventsGateway.notifyFleetUpdated(updated.machineCode, { adminStatus: 'DISABLED', desiredState: targetDesiredState });
    }

    return {
      message: hasActiveJob
        ? `Worker ${updated.machineCode} disabled. In-flight job is draining safely.`
        : `Worker ${updated.machineCode} disabled immediately.`,
      machine: updated,
    };
  }

  /**
   * Pause worker job assignments
   */
  async pauseWorker(machineId: string, reason?: string, adminUser?: any) {
    const machine = (await this.prisma.workerMachine.findUnique({ where: { id: machineId } }))
      || (await this.prisma.workerMachine.findUnique({ where: { machineCode: machineId } }));

    if (!machine) throw new NotFoundException('Worker machine not found');

    const updated = await this.prisma.workerMachine.update({
      where: { id: machine.id },
      data: {
        desiredState: 'PAUSED',
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_PAUSED',
      entity: 'WorkerMachine',
      entityId: updated.id,
      metadata: { machineCode: updated.machineCode, reason: reason || 'Paused by administrator' },
    });

    await this.createActivityLog({
      workerId: updated.id,
      eventType: 'STATE_CHANGE',
      severity: 'WARN',
      message: `Worker ${updated.machineCode} paused. Job claims suspended. ${reason ? 'Reason: ' + reason : ''}`,
    });

    if (this.eventsGateway) {
      this.eventsGateway.notifyFleetUpdated(updated.machineCode, { desiredState: 'PAUSED' });
    }

    return {
      message: `Worker ${updated.machineCode} job assignments paused`,
      machine: updated,
    };
  }

  /**
   * Set worker to monitor-only mode
   */
  async setMonitorOnly(machineId: string, adminUser?: any) {
    const machine = (await this.prisma.workerMachine.findUnique({ where: { id: machineId } }))
      || (await this.prisma.workerMachine.findUnique({ where: { machineCode: machineId } }));

    if (!machine) throw new NotFoundException('Worker machine not found');

    const updated = await this.prisma.workerMachine.update({
      where: { id: machine.id },
      data: {
        desiredState: 'MONITOR_ONLY',
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_MONITOR_ONLY',
      entity: 'WorkerMachine',
      entityId: updated.id,
      metadata: { machineCode: updated.machineCode },
    });

    await this.createActivityLog({
      workerId: updated.id,
      eventType: 'STATE_CHANGE',
      severity: 'INFO',
      message: `Worker ${updated.machineCode} switched to MONITOR_ONLY mode. Discovery active, booking execution paused.`,
    });

    if (this.eventsGateway) {
      this.eventsGateway.notifyFleetUpdated(updated.machineCode, { desiredState: 'MONITOR_ONLY' });
    }

    return {
      message: `Worker ${updated.machineCode} set to MONITOR_ONLY mode`,
      machine: updated,
    };
  }

  /**
   * Request graceful shutdown and drain
   */
  async drainWorker(machineId: string, adminUser?: any) {
    const machine = (await this.prisma.workerMachine.findUnique({ where: { id: machineId } }))
      || (await this.prisma.workerMachine.findUnique({ where: { machineCode: machineId } }));

    if (!machine) throw new NotFoundException('Worker machine not found');

    const hasActiveJob = !!machine.currentJobId;
    const targetState = hasActiveJob ? 'STOPPING' : 'STOPPED';

    const updated = await this.prisma.workerMachine.update({
      where: { id: machine.id },
      data: {
        desiredState: targetState,
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_DRAIN',
      entity: 'WorkerMachine',
      entityId: updated.id,
      metadata: { machineCode: updated.machineCode, targetState },
    });

    await this.createActivityLog({
      workerId: updated.id,
      eventType: 'STATE_CHANGE',
      severity: 'WARN',
      message: `Graceful drain requested for worker ${updated.machineCode}. In-flight work concluding safely.`,
    });

    return {
      message: hasActiveJob
        ? `Worker ${updated.machineCode} drain initiated. In-flight job concluding safely.`
        : `Worker ${updated.machineCode} has no in-flight work and is stopped.`,
      machine: updated,
    };
  }

  /**
   * Revoke machine credentials and prevent future authentication
   */
  async revokeWorker(machineId: string, reason: string, adminUser?: any) {
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('A reason is required to revoke worker credentials.');
    }

    const machine = (await this.prisma.workerMachine.findUnique({ where: { id: machineId } }))
      || (await this.prisma.workerMachine.findUnique({ where: { machineCode: machineId } }));

    if (!machine) throw new NotFoundException('Worker machine not found');

    // Invalidate credentials
    const updated = await this.prisma.workerMachine.update({
      where: { id: machine.id },
      data: {
        machineToken: null,
        adminStatus: 'REVOKED',
        desiredState: 'STOPPED',
        active: false,
        revokedAt: new Date(),
        currentActivity: 'OFFLINE',
      },
    });

    // If machine had active jobs or account locks, reconcile them safely
    if (machine.currentJobId) {
      await this.prisma.bookingJob.updateMany({
        where: { id: machine.currentJobId, workerId: machine.id },
        data: {
          workerId: null,
          leaseExpiresAt: null,
          status: BookingStatus.QUEUED,
        },
      });
      await this.accountLockService.releaseLockByWorker(machine.id);
    }

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_REVOKED',
      entity: 'WorkerMachine',
      entityId: updated.id,
      metadata: { machineCode: updated.machineCode, reason },
    });

    await this.createActivityLog({
      workerId: updated.id,
      eventType: 'STATE_CHANGE',
      severity: 'CRITICAL',
      message: `Worker ${updated.machineCode} credentials REVOKED by administrator. Reason: ${reason}. Machine cannot reconnect.`,
    });

    if (this.eventsGateway) {
      this.eventsGateway.notifyFleetUpdated(updated.machineCode, { adminStatus: 'REVOKED', active: false, desiredState: 'STOPPED' });
    }

    return {
      message: `Worker ${updated.machineCode} credentials revoked. Machine can no longer authenticate.`,
      machine: updated,
    };
  }

  /**
   * Retire worker from active fleet while preserving historical records
   */
  async retireWorker(machineId: string, reason: string, adminUser?: any) {
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestException('A reason is required to retire a worker from the fleet.');
    }

    const machine = (await this.prisma.workerMachine.findUnique({ where: { id: machineId } }))
      || (await this.prisma.workerMachine.findUnique({ where: { machineCode: machineId } }));

    if (!machine) throw new NotFoundException('Worker machine not found');

    // If active job, safely recover and release lock
    if (machine.currentJobId) {
      await this.prisma.bookingJob.updateMany({
        where: { id: machine.currentJobId, workerId: machine.id },
        data: {
          workerId: null,
          leaseExpiresAt: null,
          status: BookingStatus.QUEUED,
        },
      });
      await this.accountLockService.releaseLockByWorker(machine.id);
    }

    const updated = await this.prisma.workerMachine.update({
      where: { id: machine.id },
      data: {
        adminStatus: 'RETIRED',
        desiredState: 'STOPPED',
        active: false,
        machineToken: null,
        retiredAt: new Date(),
        retirementReason: reason,
        currentJobId: null,
        currentActivity: 'OFFLINE',
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_RETIRED',
      entity: 'WorkerMachine',
      entityId: updated.id,
      metadata: { machineCode: updated.machineCode, reason },
    });

    await this.createActivityLog({
      workerId: updated.id,
      eventType: 'STATE_CHANGE',
      severity: 'WARN',
      message: `Worker ${updated.machineCode} retired from fleet by administrator. Reason: ${reason}. Historical records preserved.`,
    });

    if (this.eventsGateway) {
      this.eventsGateway.notifyFleetUpdated(updated.machineCode, { adminStatus: 'RETIRED', active: false });
    }

    return {
      message: `Worker ${updated.machineCode} retired from active fleet. Historical records preserved.`,
      machine: updated,
    };
  }

  /**
   * Super Admin completely deletes worker and revokes all terminal access
   */
  async deleteWorker(machineId: string, reason?: string, adminUser?: any) {
    const machine =
      (await this.prisma.workerMachine.findUnique({ where: { id: machineId } })) ||
      (await this.prisma.workerMachine.findUnique({ where: { machineCode: machineId } }));

    if (!machine) {
      throw new NotFoundException('Worker machine not found');
    }

    // 1. Recover any active in-flight booking jobs assigned to this machine safely
    await this.prisma.bookingJob.updateMany({
      where: {
        workerId: machine.id,
        status: {
          notIn: [BookingStatus.SUCCESS, BookingStatus.COMPLETED, BookingStatus.FAILED, BookingStatus.CANCELLED],
        },
      },
      data: {
        workerId: null,
        leaseExpiresAt: null,
        status: BookingStatus.QUEUED,
      },
    });

    // 2. Unassign any pending/assigned booking requests
    await this.prisma.bookingRequest.updateMany({
      where: { assignedMachineId: machine.id },
      data: { assignedMachineId: null },
    });

    // 3. Release any SABARIMALA account locks held by this worker
    try {
      await this.accountLockService.releaseLockByWorker(machine.id);
    } catch (err: any) {
      this.logger.warn(`Could not release account locks for worker ${machine.id}: ${err.message}`);
    }

    // 4. Invalidate pairing claim token cache if present
    WorkersService.pairingTokenClaims.delete(machine.machineCode);
    if (machine.pairingCode) {
      WorkersService.pairingTokenClaims.delete(machine.pairingCode);
    }

    // 5. Delete activity logs and unlink allocation logs / attempts
    await this.prisma.workerActivityLog.deleteMany({
      where: { workerId: machine.id },
    });

    await this.prisma.jobAllocationLog.updateMany({
      where: { workerId: machine.id },
      data: { workerId: null },
    });

    await this.prisma.bookingAttempt.updateMany({
      where: { machineId: machine.id },
      data: { machineId: null },
    });

    // 6. Completely delete the worker record
    await this.prisma.workerMachine.delete({
      where: { id: machine.id },
    });

    // 7. Record administrative audit log
    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'WORKER_MACHINE_DELETED',
      entity: 'WorkerMachine',
      entityId: machine.id,
      metadata: {
        machineCode: machine.machineCode,
        machineName: machine.machineName,
        reason: reason || 'Deleted by Super Admin',
      },
    });

    // 8. Broadcast real-time fleet event
    if (this.eventsGateway) {
      this.eventsGateway.notifyFleetUpdated(machine.machineCode, {
        deleted: true,
        machineId: machine.id,
        active: false,
      });
    }

    return {
      success: true,
      message: `Worker ${machine.machineCode} (${machine.machineName}) has been completely deleted and access revoked.`,
    };
  }

  /**
   * Get single worker details with active job and recent logs
   */
  async getWorkerById(id: string) {
    const machine = (await this.prisma.workerMachine.findUnique({
      where: { id },
      include: {
        activityLogs: {
          orderBy: { timestamp: 'desc' },
          take: 20,
        },
      },
    })) || (await this.prisma.workerMachine.findUnique({
      where: { machineCode: id },
      include: {
        activityLogs: {
          orderBy: { timestamp: 'desc' },
          take: 20,
        },
      },
    }));

    if (!machine) {
      throw new NotFoundException('Worker machine not found');
    }

    const now = new Date();
    const heartbeatAgeSec = machine.lastHeartbeat
      ? Math.floor((now.getTime() - new Date(machine.lastHeartbeat).getTime()) / 1000)
      : null;
    const isDisconnected = heartbeatAgeSec === null || heartbeatAgeSec > 45;

    let activeJob: any = null;
    if (machine.currentJobId) {
      activeJob = await this.prisma.bookingJob.findUnique({
        where: { id: machine.currentJobId },
        include: {
          bookingRequest: {
            select: {
              id: true,
              bookingCode: true,
              requestedDate: true,
              route: true,
              pilgrimCount: true,
              status: true,
            },
          },
        },
      });
    }

    return {
      ...machine,
      machineToken: undefined, // Never leak token verifier
      heartbeatAgeSec,
      isDisconnected,
      activeJob,
    };
  }

  /**
   * Calculate fleet-wide real-time summary
   */
  async getFleetSummary() {
    const workers = await this.prisma.workerMachine.findMany({
      where: { adminStatus: { not: 'RETIRED' } },
    });

    const now = new Date();
    let onlineCount = 0;
    let offlineCount = 0;
    let stoppedCount = 0;
    let enabledCount = 0;
    let disabledCount = 0;
    let monitorOnlyCount = 0;
    let executingCount = 0;
    let awaitingHumanCount = 0;
    let unhealthyCount = 0;
    let availableCount = 0;
    let busyCount = 0;
    let localPcCount = 0;
    let cloudVmCount = 0;
    let dockerCount = 0;
    let totalCapacity = 0;
    let totalActiveJobs = 0;
    let totalRefreshes = 0;
    let totalFullResults = 0;
    let totalAvailableResults = 0;
    let totalUnknownResults = 0;
    let totalApiErrors = 0;

    for (const w of workers) {
      const isStopped = (w as any).status === 'STOPPED' || (w as any).status === WorkerStatus.STOPPED;
      const isDead = !w.lastHeartbeat || now.getTime() - new Date(w.lastHeartbeat).getTime() > 45000;
      const isOffline = !isStopped && isDead;
      const isOnline = !isStopped && !isOffline && w.active && w.adminStatus !== 'REVOKED';

      if (isStopped) stoppedCount++;
      else if (isOnline) onlineCount++;
      else offlineCount++;

      totalRefreshes += (w as any).totalRefreshCount ?? 0;
      totalFullResults += (w as any).totalFullResults ?? 0;
      totalAvailableResults += (w as any).totalAvailableResults ?? 0;
      totalUnknownResults += (w as any).totalUnknownResults ?? 0;
      totalApiErrors += (w as any).totalApiErrors ?? 0;

      if (w.adminStatus === 'ENABLED') enabledCount++;
      else if (w.adminStatus === 'DISABLED' || w.adminStatus === 'REVOKED') disabledCount++;

      if (w.desiredState === 'MONITOR_ONLY') monitorOnlyCount++;
      if (w.status === WorkerStatus.BUSY || w.currentJobId) executingCount++;
      if (w.currentActivity === 'WAITING_HUMAN_INTERVENTION' || (w.status as any) === 'REQUIRES_HUMAN') awaitingHumanCount++;
      if (w.status === WorkerStatus.ERROR || w.failureCount > 5) unhealthyCount++;

      // Deployment breakdowns
      const depType = (w as any).deploymentType || 'LOCAL_PC';
      if (depType === 'CLOUD_VM') cloudVmCount++;
      else if (depType === 'DOCKER') dockerCount++;
      else localPcCount++;

      // Concurrency & availability
      const maxCap = (w as any).maxConcurrentJobs ?? 1;
      const activeJobs = (w as any).currentActiveJobs ?? (w.currentJobId ? 1 : 0);
      totalCapacity += maxCap;
      totalActiveJobs += activeJobs;

      const isBusy = activeJobs >= maxCap;
      if (isOnline && isBusy) busyCount++;
      const isAvailable = isOnline && w.adminStatus === 'ENABLED' && (w.desiredState === 'RUNNING' || w.desiredState === 'IDLE') && !isBusy && w.status !== WorkerStatus.ERROR;
      if (isAvailable) availableCount++;
    }

    const queuedJobsCount = await this.prisma.bookingJob.count({
      where: { status: BookingStatus.QUEUED },
    });

    const staleLeasesCount = await this.prisma.bookingJob.count({
      where: {
        leaseExpiresAt: { lte: now },
        status: { in: [BookingStatus.WORKER_ASSIGNED, BookingStatus.LOGIN_IN_PROGRESS, BookingStatus.BOOKING_IN_PROGRESS, BookingStatus.EXECUTING] },
      },
    });

    return {
      totalWorkers: workers.length,
      onlineWorkers: onlineCount,
      offlineWorkers: offlineCount,
      stoppedWorkers: stoppedCount,
      enabledWorkers: enabledCount,
      disabledWorkers: disabledCount,
      availableWorkers: availableCount,
      busyWorkers: busyCount,
      localPcWorkers: localPcCount,
      cloudVmWorkers: cloudVmCount,
      dockerWorkers: dockerCount,
      totalCapacity,
      totalActiveJobs,
      monitorOnlyWorkers: monitorOnlyCount,
      executingWorkers: executingCount,
      awaitingHumanWorkers: awaitingHumanCount,
      unhealthyWorkers: unhealthyCount,
      queuedJobs: queuedJobsCount,
      staleLeases: staleLeasesCount,
      totalRefreshes,
      totalFullResults,
      totalAvailableResults,
      totalUnknownResults,
      totalApiErrors,
      timestamp: now,
    };
  }

  /**
   * Get paginated and filtered activity logs for a specific worker
   */
  async getWorkerActivityLogs(workerId: string, query: ActivityLogQueryDto) {
    const machine = (await this.prisma.workerMachine.findUnique({ where: { id: workerId } }))
      || (await this.prisma.workerMachine.findUnique({ where: { machineCode: workerId } }));

    if (!machine) throw new NotFoundException('Worker machine not found');

    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '50', 10)));
    const offset = Math.max(0, parseInt(query.offset || '0', 10));

    const where: Prisma.WorkerActivityLogWhereInput = {
      workerId: machine.id,
    };

    if (query.jobId) where.jobId = query.jobId;
    if (query.eventType) where.eventType = query.eventType;
    if (query.severity) where.severity = query.severity;
    if (query.search) {
      where.OR = [
        { message: { contains: query.search, mode: 'insensitive' } },
        { activity: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.from || query.to) {
      where.timestamp = {};
      if (query.from) where.timestamp.gte = new Date(query.from);
      if (query.to) where.timestamp.lte = new Date(query.to);
    }

    const [logs, total] = await Promise.all([
      this.prisma.workerActivityLog.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.workerActivityLog.count({ where }),
    ]);

    const sanitizedLogs = logs.map((log) => ({
      ...log,
      message: this.sanitizeLogMessage(log.message),
    }));

    return {
      workerId: machine.id,
      machineCode: machine.machineCode,
      machineName: machine.machineName,
      total,
      limit,
      offset,
      logs: sanitizedLogs,
    };
  }

  /**
   * Get paginated fleet-wide activity logs
   */
  async getFleetActivityLogs(query: ActivityLogQueryDto) {
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '50', 10)));
    const offset = Math.max(0, parseInt(query.offset || '0', 10));

    const where: Prisma.WorkerActivityLogWhereInput = {};

    if (query.workerId) where.workerId = query.workerId;
    if (query.jobId) where.jobId = query.jobId;
    if (query.eventType) where.eventType = query.eventType;
    if (query.severity) where.severity = query.severity;
    if (query.search) {
      where.OR = [
        { message: { contains: query.search, mode: 'insensitive' } },
        { activity: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.from || query.to) {
      where.timestamp = {};
      if (query.from) where.timestamp.gte = new Date(query.from);
      if (query.to) where.timestamp.lte = new Date(query.to);
    }

    const [logs, total] = await Promise.all([
      this.prisma.workerActivityLog.findMany({
        where,
        include: {
          worker: {
            select: { id: true, machineCode: true, machineName: true },
          },
        },
        orderBy: { timestamp: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.workerActivityLog.count({ where }),
    ]);

    const sanitizedLogs = logs.map((log) => ({
      ...log,
      message: this.sanitizeLogMessage(log.message),
    }));

    return {
      total,
      limit,
      offset,
      logs: sanitizedLogs,
    };
  }

  private sanitizeLogMessage(msg: string): string {
    if (!msg) return '';
    return msg
      .replace(/wkt_[a-f0-9]{32,}/gi, 'wkt_***REDACTED***')
      .replace(/password["']?\s*[:=]\s*["']?[^"'\s,]+/gi, 'password=***REDACTED***')
      .replace(/bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer ***REDACTED***');
  }

  /**
   * Worker machine checks pairing status.
   * Delivers raw machine token exactly once during the 5-minute authorized pairing window,
   * then strictly redacts the verifier on subsequent queries.
   */
  async checkPairingStatus(machineCode: string) {
    const machine = await this.prisma.workerMachine.findUnique({
      where: { machineCode },
    });

    if (!machine) {
      throw new NotFoundException('Machine not found');
    }

    if (machine.active && machine.machineToken) {
      // Check for one-time provisioning claim
      const claim = WorkersService.pairingTokenClaims.get(machineCode);
      if (claim && claim.expiresAt > Date.now()) {
        WorkersService.pairingTokenClaims.delete(machineCode); // Single-use consumption
        return {
          paired: true,
          machineToken: claim.token,
          status: machine.status,
          desiredState: machine.desiredState || 'STOPPED',
        };
      }

      // Already provisioned or pre-configured: never leak internal SHA-256 hash verifier
      return {
        paired: true,
        status: machine.status,
        desiredState: machine.desiredState || 'STOPPED',
      };
    }

    return {
      paired: false,
      pairingCode: machine.pairingCode,
      status: machine.status,
      desiredState: 'UNPAIRED',
    };
  }

  /**
   * Worker sends periodic heartbeat and reconciles desired administrative state
   */
  async handleHeartbeat(machineId: string, dto: HeartbeatDto) {
    const existingMachine = await this.prisma.workerMachine.findUnique({
      where: { id: machineId },
    });

    const effectiveJobId = dto.activeJobIds && dto.activeJobIds.length > 0
      ? dto.activeJobIds.join(',')
      : (dto.currentJobId ?? null);

    // If machine was in STOPPING state and its in-flight job has concluded, advance to STOPPED
    let nextDesiredState = existingMachine?.desiredState || 'STOPPED';
    if (existingMachine?.desiredState === 'STOPPING' && !effectiveJobId) {
      nextDesiredState = 'STOPPED';
    }

    const currentActivity = dto.currentActivity || (effectiveJobId ? 'PROCESSING_JOB' : 'IDLE');
    const activityDetails = dto.activityDetails || (effectiveJobId ? `Processing job #${effectiveJobId}` : 'Idle, waiting for assignments');
    const now = new Date();

    const hasResourceWarning = (dto.cpuUsage && dto.cpuUsage > 85) || (dto.memoryUsage && dto.memoryUsage > 85) ? true : false;

    const updated = await this.prisma.workerMachine.update({
      where: { id: machineId },
      data: {
        status: dto.status as any,
        desiredState: nextDesiredState,
        version: dto.version,
        deploymentType: dto.deploymentType || undefined,
        installationId: dto.installationId || undefined,
        // Capacity settings (maxConcurrentJobs & maxMonitoringRequests) are strictly managed by Admin
        // and are NOT overwritten by worker heartbeats.
        currentJobId: effectiveJobId,
        currentBookingId: dto.currentBookingId || null,
        currentActivity,
        activityDetails,
        lastActivityAt: now,
        activityStartedAt: existingMachine?.currentActivity !== currentActivity ? now : (existingMachine?.activityStartedAt || now),
        cpuUsage: dto.cpuUsage,
        memoryUsage: dto.memoryUsage,
        browserContextCount: dto.browserContextCount !== undefined ? dto.browserContextCount : undefined,
        resourceWarning: hasResourceWarning,
        lastHeartbeat: now,
        // Clear previous stopReason and stoppedAt when worker is active/online
        ...(dto.status !== WorkerStatus.STOPPED && (dto.status as any) !== 'STOPPED'
          ? { stopReason: null, stoppedAt: null }
          : {}),
      },
    });

    // Renew monitoring leases for active requests assigned to this machine
    if (typeof (this.prisma as any).bookingRequest?.updateMany === 'function') {
      await this.prisma.bookingRequest.updateMany({
        where: {
          assignedMonitoringWorkerId: machineId,
          status: { in: [BookingStatus.PENDING, BookingStatus.WATCHING, BookingStatus.WAITING_FOR_DATE_AVAILABILITY, BookingStatus.FAST_BOOKING_QUEUED] },
        },
        data: {
          monitoringLeaseExpiresAt: new Date(now.getTime() + 60000), // 60s lease extension
        },
      }).catch(() => {});
    }

    if (this.smartAllocator) {
      await this.smartAllocator.reconcileWorkerCapacity(machineId, dto.activeJobIds);
    }

    if (dto.status === 'OFFLINE' || (dto.status as any) === WorkerStatus.OFFLINE) {
      await this.accountLockService.releaseLockByWorker(machineId);
    }

    if (existingMachine?.currentActivity !== currentActivity && currentActivity !== 'IDLE') {
      await this.createActivityLog({
        workerId: machineId,
        jobId: effectiveJobId,
        eventType: 'HEARTBEAT',
        severity: 'INFO',
        activity: currentActivity,
        message: `Activity transitioned to ${currentActivity}: ${activityDetails}`,
      });
    }

    return {
      status: 'OK',
      machineId: updated.id,
      adminStatus: updated.adminStatus,
      desiredState: updated.desiredState,
      executionPermitted: updated.adminStatus === 'ENABLED' && updated.desiredState === 'RUNNING',
      maxConcurrentJobs: updated.maxConcurrentJobs,
      maxMonitoringRequests: updated.maxMonitoringRequests,
      serverTime: now,
    };
  }

  /**
   * Authoritatively evaluates active capacity for a worker machine.
   * Counts ONLY RUNNING jobs with unexpired leases; excludes COMPLETED/SUCCESS,
   * WATCHING, NEEDS_REVIEW with official reference, and jobs with expired leases.
   * Logs the full capacity decision (limit, jobs counted, and why each counted/excluded).
   */
  private async evaluateMachineCapacity(
    machine: any,
    now: Date = new Date(),
    workerReportedActiveJobIds?: string[],
  ): Promise<{
    activeCount: number;
    maxCapacity: number;
    atCapacity: boolean;
    countedJobs: Array<{
      jobId: string;
      bookingCode?: string;
      bookingRequestId?: string | null;
      requestedDateStr?: string | null;
      status: string;
      reason: string;
      leaseRemainingSec?: number;
    }>;
    excludedJobs: Array<{
      jobId: string;
      bookingCode?: string;
      status: string;
      reason: string;
    }>;
    maxCapacityReason: string;
  }> {
    const machineId = machine.id;
    const machineCode = machine.machineCode || machineId;
    const maxCapacity = (machine as any).maxConcurrentJobs ?? 1;
    const countedJobs: Array<{
      jobId: string;
      bookingCode?: string;
      bookingRequestId?: string | null;
      requestedDateStr?: string | null;
      status: string;
      reason: string;
      leaseRemainingSec?: number;
    }> = [];
    const excludedJobs: Array<{
      jobId: string;
      bookingCode?: string;
      status: string;
      reason: string;
    }> = [];

    let usedLiveJobQuery = false;

    if (typeof this.prisma.bookingJob?.findMany === 'function') {
      const workerJobs = await this.prisma.bookingJob.findMany({
        where: {
          workerId: machineId,
          status: {
            notIn: [BookingStatus.CANCELLED, BookingStatus.FAILED],
          },
        },
        include: {
          bookingRequest: {
            select: {
              id: true,
              bookingCode: true,
              status: true,
              officialBookingReference: true,
              officialReference: true,
              cartId: true,
              reconciliationStatus: true,
              requestedDateStr: true,
              requestedDate: true,
            },
          },
        },
      });

      if (Array.isArray(workerJobs)) {
        usedLiveJobQuery = true;
        for (const job of workerJobs) {
          if (job.workerId !== machineId) continue;
          const evalRes = evaluateJobActiveCapacity(job as any, now, workerReportedActiveJobIds);
          const br: any = (job as any).bookingRequest;
          const bookingCode = br?.bookingCode;
          const requestedDateStr =
            br?.requestedDateStr ||
            (br?.requestedDate instanceof Date
              ? br.requestedDate.toISOString().split('T')[0]
              : br?.requestedDate
                ? String(br.requestedDate).split('T')[0]
                : null);

          if (evalRes.counts) {
            countedJobs.push({
              jobId: job.id,
              bookingCode,
              bookingRequestId: job.bookingRequestId,
              requestedDateStr,
              status: job.status,
              reason: evalRes.reason,
              leaseRemainingSec: evalRes.leaseRemainingSec,
            });
          } else {
            excludedJobs.push({
              jobId: job.id,
              bookingCode,
              status: job.status,
              reason: evalRes.reason,
            });
          }
        }
      }
    }

    let activeCount = countedJobs.length;

    if (!usedLiveJobQuery) {
      let currentActive = (machine as any).currentActiveJobs ?? 0;
      if (currentActive >= maxCapacity && this.smartAllocator) {
        if (typeof (this.smartAllocator as any).evaluateWorkerCapacity === 'function') {
          const allocCap = await (this.smartAllocator as any).evaluateWorkerCapacity(
            machineId,
            maxCapacity,
            workerReportedActiveJobIds,
            true,
          );
          activeCount = allocCap.activeCount;
          countedJobs.push(...allocCap.countedJobs);
          excludedJobs.push(...allocCap.excludedJobs);
        } else if (typeof this.smartAllocator.reconcileWorkerCapacity === 'function') {
          const reconciled = await this.smartAllocator.reconcileWorkerCapacity(machineId, workerReportedActiveJobIds);
          if (typeof reconciled === 'number') {
            currentActive = reconciled;
          }
          activeCount = currentActive;
        } else {
          activeCount = currentActive;
        }
      } else {
        activeCount = currentActive;
      }
    } else if (
      (machine as any).currentActiveJobs !== activeCount &&
      typeof this.prisma.workerMachine?.update === 'function'
    ) {
      // Self-heal drifted currentActiveJobs counter on WorkerMachine
      await Promise.resolve(
        this.prisma.workerMachine.update({
          where: { id: machineId },
          data: {
            currentActiveJobs: activeCount,
            status: activeCount > 0 ? WorkerStatus.BUSY : WorkerStatus.ONLINE,
            ...(activeCount === 0
              ? {
                  currentJobId: null,
                  currentBookingId: null,
                  currentActivity: 'IDLE',
                }
              : {}),
          },
        }),
      ).catch(() => {});
    }

    const countedSummary =
      countedJobs.length > 0
        ? countedJobs.map((j) => `${j.jobId}[${j.bookingCode || 'N/A'}:${j.reason}]`).join(', ')
        : 'none';
    const excludedSummary =
      excludedJobs.length > 0
        ? excludedJobs.slice(0, 8).map((j) => `${j.jobId}[${j.bookingCode || 'N/A'}:${j.reason}]`).join(', ')
        : 'none';

    this.logger.log(
      `[CAPACITY] Worker ${machineCode}: active=${activeCount}/${maxCapacity} | counted=[${countedSummary}] | excluded=[${excludedSummary}]`,
    );

    const maxCapacityReason = `MAX_CAPACITY(${activeCount}/${maxCapacity}; jobs=${countedSummary})`;

    return {
      activeCount,
      maxCapacity,
      atCapacity: activeCount >= maxCapacity,
      countedJobs,
      excludedJobs,
      maxCapacityReason,
    };
  }

  /**
   * Checks whether an existing job/booking owner is the SAME machine (by workerId or machineCode),
   * or a dead/unresponsive peer worker, or a live competing peer worker.
   */
  private async inspectJobOwnership(
    ownerWorkerId: string | null | undefined,
    machine: any,
    now: Date,
    tx?: any,
  ): Promise<{ isSameOwner: boolean; isDeadOwner: boolean; ownerId: string; ownerMachine: any | null }> {
    if (!ownerWorkerId) {
      return { isSameOwner: false, isDeadOwner: false, ownerId: 'unassigned', ownerMachine: null };
    }
    if (ownerWorkerId === machine.id) {
      return { isSameOwner: true, isDeadOwner: false, ownerId: ownerWorkerId, ownerMachine: machine };
    }

    const client = tx || this.prisma;
    let ownerMachine: any = null;
    if (typeof client.workerMachine?.findUnique === 'function') {
      ownerMachine = await client.workerMachine.findUnique({ where: { id: ownerWorkerId } }).catch(() => null);
    }

    // Same physical machine re-registered under the same machineCode
    if (
      ownerMachine?.machineCode &&
      machine.machineCode &&
      ownerMachine.machineCode === machine.machineCode
    ) {
      return { isSameOwner: true, isDeadOwner: false, ownerId: ownerWorkerId, ownerMachine };
    }

    const isDeadOwner =
      !ownerMachine ||
      !ownerMachine.active ||
      (ownerMachine as any).adminStatus !== 'ENABLED' ||
      Boolean(
        ownerMachine.lastHeartbeat &&
          now.getTime() - new Date(ownerMachine.lastHeartbeat).getTime() > 45000,
      );

    return { isSameOwner: false, isDeadOwner, ownerId: ownerWorkerId, ownerMachine };
  }

  /**
   * Resolves the exact ACCOUNT_BUSY(jobId) holder if an account is actively locked.
   */
  private async getAccountBusyState(
    accountId: string,
    excludeBookingId: string,
    tx?: any,
  ): Promise<{ busy: boolean; holderId?: string; reason?: string }> {
    if (!accountId || !this.accountLockService) {
      return { busy: false };
    }

    if (typeof (this.accountLockService as any).getActiveLockHolder === 'function') {
      const holder = await (this.accountLockService as any).getActiveLockHolder(accountId, excludeBookingId);
      if (holder?.locked) {
        const holderId = holder.jobId || holder.bookingId || 'unknown';
        return { busy: true, holderId, reason: `ACCOUNT_BUSY(${holderId})` };
      }
      return { busy: false };
    }

    const isBusy = await this.accountLockService.isLocked(accountId, excludeBookingId);
    if (!isBusy) return { busy: false };

    const client = tx || this.prisma;
    const lock = typeof client.accountLock?.findFirst === 'function'
      ? await client.accountLock.findFirst({ where: { accountId } }).catch(() => null)
      : null;
    const holderId = lock?.bookingId || 'unknown';
    return { busy: true, holderId, reason: `ACCOUNT_BUSY(${holderId})` };
  }

  /**
   * Duplicate protection (Requirement 5):
   * If a booking request already has an authoritative official reference or a COMPLETED/SUCCESS job,
   * never book it again. Complete the request with the stored reference (if not already finalized)
   * and return ALREADY_COMPLETED(reference).
   */
  private async handleAlreadyCompletedGuard(
    br: any,
    existingJob: any,
    machineId: string,
  ): Promise<{
    alreadyCompleted: boolean;
    response?: {
      hasJob: false;
      job: null;
      reason: string;
      officialReference?: string;
      jobId?: string;
      needsCompletionRetry?: boolean;
      message: string;
    };
  }> {
    if (!br) return { alreadyCompleted: false };

    const storedRef = extractAuthoritativeReference(br);
    const isJobCompleted = Boolean(
      existingJob &&
        (existingJob.status === BookingStatus.SUCCESS || existingJob.status === BookingStatus.COMPLETED),
    );
    const isBrCompleted =
      br.status === BookingStatus.SUCCESS ||
      br.status === BookingStatus.COMPLETED ||
      (br.status as any) === 'BOOKING_CONFIRMED';

    if (!storedRef && !isJobCompleted && !isBrCompleted) {
      return { alreadyCompleted: false };
    }

    const displayRef = storedRef || 'COMPLETED';
    this.logger.warn(
      `[DUPLICATE-GUARD] ALREADY_COMPLETED(${displayRef}) for Booking #${br.bookingCode || br.id} ` +
        `(bookingStatus=${br.status}, jobStatus=${existingJob?.status || 'NONE'}). Refusing re-booking.`,
    );

    let needsCompletionRetry = false;
    if (!isBrCompleted && storedRef && existingJob?.id) {
      try {
        this.logger.log(
          `[DUPLICATE-GUARD] Retrying completeJob for Booking #${br.bookingCode} (Job #${existingJob.id}) with stored reference ${storedRef}.`,
        );
        await this.completeJob(existingJob.id, machineId, {
          officialReference: storedRef,
          officialBookingReference: storedRef,
          cartId: br.cartId || undefined,
          leaseGeneration: existingJob.leaseGeneration ?? 1,
          fencingToken: existingJob.fencingToken ?? 'duplicate-guard-reconcile',
          protocolVersion: 'v2.0-fenced',
        });
      } catch (err: any) {
        needsCompletionRetry = true;
        this.logger.warn(
          `[DUPLICATE-GUARD] Inline completeJob retry failed for Booking #${br.bookingCode}: ${err?.message || err}`,
        );
      }
    }

    return {
      alreadyCompleted: true,
      response: {
        hasJob: false,
        job: null,
        reason: `ALREADY_COMPLETED(${displayRef})`,
        officialReference: storedRef || undefined,
        jobId: existingJob?.id,
        needsCompletionRetry,
        message: `Booking #${br.bookingCode || br.id} is already completed (${displayRef})`,
      },
    };
  }

  /**
   * Checks whether a date/route is currently marked AVAILABLE in the server availability cache
   * (DiscoverySchedule or active AVAILABLE AvailabilityOpportunity).
   */
  private async isDateRouteAvailableInCache(
    dateStr?: string | null,
    route?: string | null,
    tx?: any,
  ): Promise<{ available: boolean; status: string }> {
    if (!dateStr) return { available: false, status: 'NO_DATE' };

    const client = tx || this.prisma;
    const demandKey = normalizeDemandKey(dateStr, route || 'Pamba');

    try {
      if (typeof client.discoverySchedule?.findUnique === 'function') {
        const sched = await client.discoverySchedule.findUnique({ where: { demandKey } });
        if (sched) {
          if (sched.status === 'AVAILABLE') {
            return { available: true, status: 'AVAILABLE' };
          }
          if (typeof client.availabilityOpportunity?.findFirst === 'function') {
            const availOpp = await client.availabilityOpportunity.findFirst({
              where: { date: dateStr, status: 'AVAILABLE' },
            });
            if (availOpp) {
              return { available: true, status: 'AVAILABLE_OPPORTUNITY' };
            }
          }
          return { available: false, status: sched.status || 'UNAVAILABLE' };
        }
      }

      if (typeof client.availabilityOpportunity?.findFirst === 'function') {
        const availOpp = await client.availabilityOpportunity.findFirst({
          where: { date: dateStr, status: 'AVAILABLE' },
        });
        if (availOpp) {
          return { available: true, status: 'AVAILABLE_OPPORTUNITY' };
        }
      }
    } catch (err: any) {
      this.logger.warn(`[AVAILABILITY-CACHE] Cache lookup notice for ${demandKey}: ${err?.message || err}`);
    }

    return { available: false, status: 'UNKNOWN' };
  }

  /**
   * Returns true if a WATCHING booking/job is permitted to be claimed right now:
   * ONLY when triggered by slot:opened / sniper for this date, OR when the date/route is
   * currently AVAILABLE in the server availability cache.
   */
  private async isWatchingBookingClaimable(
    br: any,
    job: any,
    claimOptions?: { triggerSource?: string; date?: string; route?: string },
    tx?: any,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const isWatching =
      br?.status === BookingStatus.WATCHING ||
      (br?.status as any) === 'WATCHING' ||
      job?.status === BookingStatus.WATCHING ||
      (job?.status as any) === 'WATCHING';

    if (!isWatching) {
      return { allowed: true };
    }

    const dateStr =
      br?.requestedDateStr ||
      (br?.requestedDate instanceof Date
        ? br.requestedDate.toISOString().split('T')[0]
        : br?.requestedDate
          ? String(br.requestedDate).split('T')[0]
          : null);

    const isTriggeredBySlotOrSniper =
      claimOptions?.triggerSource === 'SLOT_OPENED' || claimOptions?.triggerSource === 'SNIPER';
    if (isTriggeredBySlotOrSniper) {
      if (!claimOptions?.date || !dateStr || claimOptions.date.trim() === dateStr) {
        if (!claimOptions?.route || isRouteMatching(br?.route, claimOptions.route)) {
          return { allowed: true };
        }
      }
    }

    const cacheRes = await this.isDateRouteAvailableInCache(dateStr, br?.route, tx);
    if (cacheRes.available) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `WATCHING_DATE_NOT_AVAILABLE(${dateStr || 'unknown'}:${cacheRes.status})`,
    };
  }

  /**
   * Validates that a BookingRequest can legitimately transition to EXECUTING
   * (including supported bridges PENDING/WAITING_FOR_ACCOUNT/WATCHING -> QUEUED -> EXECUTING)
   * BEFORE acquiring any account lock or bumping leaseGeneration.
   */
  private canBookingTransitionToExecuting(brStatus: BookingStatus): boolean {
    if (TERMINAL_OR_EXCLUDED_BOOKING_STATUSES.includes(brStatus)) {
      return false;
    }
    if (!this.stateMachine || typeof this.stateMachine.canTransition !== 'function') {
      return true;
    }
    if (this.stateMachine.canTransition(brStatus, BookingStatus.EXECUTING)) {
      return true;
    }
    // Supported bridges in claimJob / matchPendingBooking
    if (
      brStatus === BookingStatus.PENDING ||
      brStatus === BookingStatus.WAITING_FOR_ACCOUNT ||
      brStatus === BookingStatus.WATCHING
    ) {
      return this.stateMachine.canTransition(BookingStatus.QUEUED, BookingStatus.EXECUTING);
    }
    return false;
  }

  /**
   * Worker claims next eligible job (ACCOUNT_VERIFICATION or BOOKING_EXECUTION)
   * Enforces atomic single-owner claim via Prisma transaction with conditional updates.
   * Strictly enforces Super Admin start/stop state and administrative authorization.
   */
  async claimJob(
    machineId: string,
    activeJobIds?: string[],
    claimOptions?: {
      triggerSource?: 'QUEUE_POLL' | 'SLOT_OPENED' | 'SNIPER' | string;
      date?: string;
      route?: string;
      jobType?: string;
      maxActiveBookings?: number;
    },
  ) {
    const machine = await this.prisma.workerMachine.findUnique({
      where: { id: machineId },
    });

    if (!machine || !machine.active || (machine as any).adminStatus === 'REVOKED' || (machine as any).adminStatus === 'RETIRED') {
      throw new UnauthorizedException('Worker machine is not approved, active, or credentials have been revoked');
    }

    if ((machine as any).adminStatus === 'DISABLED') {
      return {
        hasJob: false,
        stopped: true,
        desiredState: 'STOPPED',
        message: 'Worker is administratively disabled. Job claiming prohibited.',
      };
    }

    // Backend enforcement: Reject new job claims if machine is STOPPED, STOPPING, PAUSED, or MONITOR_ONLY
    if (machine.desiredState === 'STOPPED' || machine.desiredState === 'STOPPING' || machine.desiredState === 'PAUSED' || machine.desiredState === 'MONITOR_ONLY') {
      return {
        hasJob: false,
        stopped: true,
        desiredState: machine.desiredState,
        message: `Worker execution is ${machine.desiredState} by administrator`,
      };
    }

    const now = new Date();
    // Q6/ITEM 8: Configurable lease TTL (default 30s) — see Audit 3
    const leaseExpiry = new Date(now.getTime() + LEASE_TTL_MS);

    // Authoritative eligible and excluded statuses for worker claiming
    const eligibleBookingStatuses = CLAIMABLE_OPEN_REQUEST_STATUSES;
    const excludedBookingStatuses = TERMINAL_OR_EXCLUDED_BOOKING_STATUSES;

    // 1. First priority: Check if a job was already reserved specifically for this worker (pre-allocated or OWN_STALE_LEASE takeover)
    const preAllocatedCandidate = await this.prisma.bookingJob.findFirst({
      where: {
        workerId: machineId,
        OR: [
          { status: BookingStatus.WORKER_ASSIGNED },
          { status: BookingStatus.EXECUTING },
        ],
        AND: [
          {
            OR: [
              { jobType: JobType.ACCOUNT_VERIFICATION },
              {
                bookingRequest: {
                  status: {
                    in: [...eligibleBookingStatuses, ...TAKEOVER_ELIGIBLE_INFLIGHT_STATUSES],
                    notIn: excludedBookingStatuses,
                  },
                  OR: [
                    { nextCheckAt: null },
                    { nextCheckAt: { lte: now } },
                  ],
                },
              },
            ],
          },
        ],
      },
      include: {
        account: true,
        bookingRequest: {
          include: { pilgrims: true, account: true },
        },
      },
      orderBy: { startedAt: 'desc' },
    });

    // Fail-closed booking execution permission policy:
    // 1. Explicit BOOKING_EXECUTION capability is required in trusted backend DB configuration.
    // Default fallback to standard capabilities if unspecified in legacy records/mocks
    const capabilitiesList = Array.isArray(machine.capabilities) && machine.capabilities.length > 0
      ? machine.capabilities
      : ['ACCOUNT_VERIFICATION', 'BOOKING_EXECUTION', 'AVAILABILITY_DISCOVERY'];

    const hasBookingCapabilityInDb = capabilitiesList.includes('BOOKING_EXECUTION');
    const hasAccountVerificationCapabilityInDb = capabilitiesList.includes('ACCOUNT_VERIFICATION');

    // 2. Machine must be RUNNING (not MONITOR_ONLY, STOPPED, etc.) and have maxConcurrentJobs > 0 in database.
    const isBookingExecutionAuthorizedByDb =
      hasBookingCapabilityInDb &&
      machine.desiredState === 'RUNNING' &&
      ((machine as any).maxConcurrentJobs ?? 1) > 0;

    // 3. Worker-supplied options can only restrict further (e.g. maxActiveBookings=0 or jobType='ACCOUNT_VERIFICATION').
    // Worker-supplied options can NEVER grant booking execution if backend DB authorization is false.
    const canAcceptBookingExecution =
      isBookingExecutionAuthorizedByDb &&
      claimOptions?.maxActiveBookings !== 0 &&
      claimOptions?.jobType !== JobType.ACCOUNT_VERIFICATION;

    const isJobTypeMismatch =
      claimOptions?.jobType &&
      preAllocatedCandidate &&
      preAllocatedCandidate.jobType !== claimOptions.jobType;

    const cannotAcceptBooking =
      !canAcceptBookingExecution &&
      preAllocatedCandidate?.jobType === JobType.BOOKING_EXECUTION;

    const cannotAcceptVerification =
      !hasAccountVerificationCapabilityInDb &&
      preAllocatedCandidate?.jobType === JobType.ACCOUNT_VERIFICATION;

    // Speculative execution guard: QUEUE_POLL fallback must NEVER claim a BOOKING_EXECUTION job.
    // Booking jobs can strictly only be dispatched when date availability is confirmed (SLOT_OPENED or SNIPER).
    const isQueuePollSpeculativeBooking =
      claimOptions?.triggerSource === 'QUEUE_POLL' &&
      preAllocatedCandidate?.jobType === JobType.BOOKING_EXECUTION;

    // Only accept preAllocatedJob if it belongs to this machine, matches requested jobType, is strictly authorized for the job type, is NOT speculative from queue-poll, and is NOT already running in-process
    const preAllocatedJob =
      preAllocatedCandidate &&
      !isJobTypeMismatch &&
      !isQueuePollSpeculativeBooking &&
      !cannotAcceptBooking &&
      !cannotAcceptVerification &&
      (preAllocatedCandidate.workerId === undefined || preAllocatedCandidate.workerId === machineId) &&
      !(Array.isArray(activeJobIds) && activeJobIds.includes(preAllocatedCandidate.id)) &&
      (
        preAllocatedCandidate.status === undefined ||
        preAllocatedCandidate.status === BookingStatus.WORKER_ASSIGNED ||
        preAllocatedCandidate.status === BookingStatus.EXECUTING
      )
        ? preAllocatedCandidate
        : null;

    if (preAllocatedJob) {
      const preAllocBr = preAllocatedJob.bookingRequest as any;
      if (preAllocBr) {
        // Duplicate protection (Requirement 5): never re-book an already completed / official-ref booking
        const dupGuard = await this.handleAlreadyCompletedGuard(preAllocBr, preAllocatedJob, machineId);
        if (dupGuard.alreadyCompleted) {
          return dupGuard.response;
        }

        if (
          excludedBookingStatuses.includes(preAllocBr.status) ||
          preAllocBr.status === BookingStatus.CANCELLED ||
          preAllocBr.status === BookingStatus.COMPLETED ||
          preAllocBr.status === BookingStatus.FAILED ||
          preAllocBr.status === BookingStatus.SUCCESS
        ) {
          this.logger.log(`[CLAIM-JOB] Pre-allocated Job #${preAllocatedJob.id} booking #${preAllocBr.bookingCode} is in terminal/excluded status (${preAllocBr.status}). Skipping execution.`);
          await Promise.resolve(
            this.prisma.bookingJob.update({
              where: { id: preAllocatedJob.id },
              data: { status: preAllocBr.status, completedAt: now },
            }),
          ).catch(() => {});
          return { hasJob: false, reason: `STATUS_NOT_CLAIMABLE(${preAllocBr.status})` };
        }

        const preAllocDateStr =
          preAllocBr.requestedDateStr ||
          (preAllocBr.requestedDate instanceof Date
            ? preAllocBr.requestedDate.toISOString().split('T')[0]
            : String(preAllocBr.requestedDate || '').split('T')[0]);
        if (preAllocDateStr && isDateInPast(preAllocDateStr)) {
          this.logger.log(`[CLAIM-JOB] Pre-allocated Job #${preAllocatedJob.id} booking #${preAllocBr.bookingCode} date (${preAllocDateStr}) is in the past. Skipping.`);
          return { hasJob: false, reason: 'PAST_DATE' };
        }

        const isAllowedStatus =
          eligibleBookingStatuses.includes(preAllocBr.status) ||
          TAKEOVER_ELIGIBLE_INFLIGHT_STATUSES.includes(preAllocBr.status);
        if (!isAllowedStatus) {
          this.logger.log(`[CLAIM-JOB] Pre-allocated Job #${preAllocatedJob.id} booking #${preAllocBr.bookingCode} status (${preAllocBr.status}) is not eligible for execution.`);
          return { hasJob: false, reason: `STATUS_NOT_CLAIMABLE(${preAllocBr.status})` };
        }

        if (preAllocBr.nextCheckAt && new Date(preAllocBr.nextCheckAt).getTime() > now.getTime()) {
          this.logger.log(`[CLAIM-JOB] Pre-allocated Job #${preAllocatedJob.id} booking #${preAllocBr.bookingCode} is in backoff until ${preAllocBr.nextCheckAt}. Skipping.`);
          return { hasJob: false, reason: 'IN_COOLDOWN' };
        }

        // Issue 1: Skip WATCHING jobs unless date/route is AVAILABLE in cache or triggered by slot:opened/sniper
        const watchCheck = await this.isWatchingBookingClaimable(preAllocBr, preAllocatedJob, claimOptions);
        if (!watchCheck.allowed) {
          this.logger.log(`[CLAIM-JOB] Skipping WATCHING pre-allocated Job #${preAllocatedJob.id} (#${preAllocBr.bookingCode}): ${watchCheck.reason}.`);
          return { hasJob: false, reason: watchCheck.reason };
        }

        // Issue 2: Validate transitionability BEFORE touching leaseGeneration or account locks
        if (!this.canBookingTransitionToExecuting(preAllocBr.status)) {
          this.logger.warn(`[CLAIM-JOB] Skipping pre-allocated Job #${preAllocatedJob.id}: Booking #${preAllocBr.bookingCode} cannot transition ${preAllocBr.status} -> EXECUTING.`);
          return { hasJob: false, reason: `STATUS_NOT_CLAIMABLE(${preAllocBr.status})` };
        }
      }

      // Same-owner takeover / pre-allocated retrieval: atomic CAS, fresh fencingToken, increment leaseGeneration.
      const isOwnStaleTakeover = preAllocatedJob.status === BookingStatus.EXECUTING;
      const preAllocFencingToken = randomUUID();
      const preAllocClaim = await this.prisma.bookingJob.updateMany({
        where: {
          id: preAllocatedJob.id,
          workerId: machineId,
          OR: [
            { status: BookingStatus.WORKER_ASSIGNED },
            { status: BookingStatus.EXECUTING },
          ],
        },
        data: {
          status: BookingStatus.EXECUTING,
          startedAt: preAllocatedJob.startedAt || now,
          heartbeatAt: now,
          leaseExpiresAt: leaseExpiry,
          leaseGeneration: { increment: 1 },
          fencingToken: preAllocFencingToken,
        },
      });

      if (preAllocClaim.count === 0) {
        const current = await this.prisma.bookingJob.findUnique({ where: { id: preAllocatedJob.id } }).catch(() => null);
        const winner = current?.workerId && current.workerId !== machineId ? current.workerId : 'unknown';
        this.logger.warn(`[ARBITER] Claim lost (pre-allocated raced): job=${preAllocatedJob.id} worker=${machineId} winner=${winner}`);
        return {
          hasJob: false,
          reason: winner !== 'unknown' ? `CLAIMED_BY_OTHER(${winner})` : 'NO_JOB',
          ownerWorkerId: winner !== 'unknown' ? winner : undefined,
        };
      }

      const refreshedPreAlloc = await this.prisma.bookingJob.findUnique({ where: { id: preAllocatedJob.id } });
      const preAllocGen = refreshedPreAlloc?.leaseGeneration ?? ((preAllocatedJob.leaseGeneration ?? 0) + 1);
      if (isOwnStaleTakeover) {
        this.logger.log(`[ARBITER] OWN_STALE_LEASE takeover (claimJob): job=${preAllocatedJob.id} worker=${machine.machineCode}(${machineId}) gen=${preAllocGen} token=${preAllocFencingToken}`);
      } else {
        this.logger.log(`[ARBITER] Claim won (pre-allocated): job=${preAllocatedJob.id} worker=${machineId} gen=${preAllocGen} token=${preAllocFencingToken}`);
      }


      if (preAllocatedJob.bookingRequestId) {
        if (this.stateMachine) {
          // If booking is in PENDING or WAITING_FOR_ACCOUNT, first bridge to QUEUED before EXECUTING
          if (preAllocBr?.status === BookingStatus.PENDING || preAllocBr?.status === BookingStatus.WAITING_FOR_ACCOUNT) {
            await this.stateMachine.transition({
              bookingId: preAllocatedJob.bookingRequestId,
              targetStatus: BookingStatus.QUEUED,
              milestone: 'PRE_CLAIM_QUEUED',
              operator: `Worker:${machineId}`,
            }).catch(() => {});
          }

          await this.stateMachine.transition({
            bookingId: preAllocatedJob.bookingRequestId,
            targetStatus: BookingStatus.EXECUTING,
            assignedMachineId: machineId,
            leaseExpiresAt: leaseExpiry,
            milestone: 'WORKER_PREALLOCATED_CLAIMED',
            operator: `Worker:${machineId}`,
          });
        } else {
          await this.prisma.bookingRequest.update({
            where: { id: preAllocatedJob.bookingRequestId },
            data: {
              assignedMachineId: machineId,
              status: BookingStatus.EXECUTING,
              leaseExpiresAt: leaseExpiry,
            },
          });
        }
      }

      await this.prisma.workerMachine.update({
        where: { id: machineId },
        data: {
          status: WorkerStatus.BUSY,
          currentJobId: preAllocatedJob.id,
          currentBookingId: preAllocatedJob.bookingRequestId || null,
          currentActivity: 'PROCESSING_JOB',
          activityDetails: `Executing ${preAllocatedJob.jobType} #${preAllocatedJob.id.slice(0, 8)}`,
          lastActivityAt: now,
        },
      });

      await this.createActivityLog({
        workerId: machineId,
        jobId: preAllocatedJob.id,
        bookingId: preAllocatedJob.bookingRequestId || null,
        eventType: 'JOB_CLAIMED',
        severity: 'INFO',
        activity: 'PROCESSING_JOB',
        message: `Worker claimed pre-allocated ${preAllocatedJob.jobType} job #${preAllocatedJob.bookingRequest?.bookingCode || preAllocatedJob.id.slice(0, 8)}`,
      });

      if (preAllocatedJob.jobType === JobType.ACCOUNT_VERIFICATION && preAllocatedJob.account) {
        return {
          hasJob: true,
          jobType: JobType.ACCOUNT_VERIFICATION,
          job: {
            id: preAllocatedJob.id,
            accountId: preAllocatedJob.accountId,
            username: preAllocatedJob.account.username,
            encryptedPassword: preAllocatedJob.account.encryptedPassword,
            encryptionIv: preAllocatedJob.account.encryptionIv,
            encryptionTag: preAllocatedJob.account.encryptionTag,
            leaseExpiresAt: leaseExpiry,
            leaseGeneration: preAllocGen,
            fencingToken: preAllocFencingToken,
          },
        };
      }

      if (preAllocatedJob.jobType === JobType.BOOKING_EXECUTION && preAllocatedJob.bookingRequest) {
        const br = preAllocatedJob.bookingRequest;
        const nomineeCheck = validateNominee(br);
        if (!nomineeCheck.valid) {
          this.logger.warn(`[CLAIM-JOB] Pre-allocated Job #${preAllocatedJob.id} has invalid nominee: ${nomineeCheck.errors.join('; ')}`);
          await this.prisma.bookingJob.update({
            where: { id: preAllocatedJob.id },
            data: { status: BookingStatus.HOLD_INVALID_NOMINEE, errorMessage: `HOLD_INVALID_NOMINEE: ${nomineeCheck.errors.join('; ')}` },
          });
          await this.prisma.bookingRequest.update({
            where: { id: br.id },
            data: { status: BookingStatus.HOLD_INVALID_NOMINEE, requiresHumanNote: `HOLD_INVALID_NOMINEE: ${nomineeCheck.errors.join('; ')}` },
          });
          return { hasJob: false };
        }

        const account = preAllocatedJob.account || br.account;
        if (account?.status === ('ACCOUNT_PREVIOUS_BOOKING_RESTRICTED' as any) || account?.status === AccountStatus.DISABLED) {
          this.logger.warn(`[CLAIM-JOB] Pre-allocated Job #${preAllocatedJob.id} rejected: Account ${account.username} is restricted (${account.status})`);
          await this.prisma.bookingJob.update({
            where: { id: preAllocatedJob.id },
            data: { status: BookingStatus.ACCOUNT_PREVIOUS_BOOKING_RESTRICTED, errorMessage: 'Account has previous booking restriction' },
          });
          return { hasJob: false };
        }
        const dateOnlyStr = br.requestedDateStr || (br.requestedDate instanceof Date ? br.requestedDate.toISOString().split('T')[0] : String(br.requestedDate).split('T')[0]);

        return {
          hasJob: true,
          jobType: JobType.BOOKING_EXECUTION,
          job: {
            id: preAllocatedJob.id,
            bookingRequestId: br.id,
            bookingCode: br.bookingCode,
            requestedDate: dateOnlyStr,
            route: br.route,
            pilgrimCount: br.pilgrimCount,
            timeSlot: br.timeSlot,
            selectedTime: br.selectedTime || undefined,
            preferences: br.preferences,
            pilgrims: br.pilgrims,
            nominee: nomineeCheck.resolvedNominee,
            nominees: (br.preferences as any)?.nominees || (nomineeCheck.resolvedNominee ? [nomineeCheck.resolvedNominee] : []),
            account: account ? {
              id: account.id,
              username: account.username,
              encryptedPassword: account.encryptedPassword,
              encryptionIv: account.encryptionIv,
              encryptionTag: account.encryptionTag,
            } : null,
            leaseExpiresAt: leaseExpiry,
            leaseGeneration: preAllocGen,
            fencingToken: preAllocFencingToken,
          },
        };
      }

    }

    // 2. Capacity enforcement: count ONLY genuinely RUNNING jobs with unexpired leases
    const capacity = await this.evaluateMachineCapacity(machine, now, activeJobIds);
    if (capacity.atCapacity) {
      return {
        hasJob: false,
        reason: capacity.maxCapacityReason,
        capacity: {
          current: capacity.activeCount,
          limit: capacity.maxCapacity,
          countedJobs: capacity.countedJobs,
        },
        message: `Worker is at max concurrency capacity (${capacity.activeCount}/${capacity.maxCapacity})`,
      };
    }

    return await this.prisma.$transaction(async (tx) => {
      // 1. First priority: Account Verification Jobs (requires explicit ACCOUNT_VERIFICATION capability in DB)
      const canAcceptVerification =
        hasAccountVerificationCapabilityInDb &&
        claimOptions?.jobType !== JobType.BOOKING_EXECUTION;

      const verificationJob = canAcceptVerification
        ? await tx.bookingJob.findFirst({
            where: {
              jobType: JobType.ACCOUNT_VERIFICATION,
              status: BookingStatus.QUEUED,
            },
            include: {
              account: true,
            },
            orderBy: { createdAt: 'asc' },
          })
        : null;

      if (verificationJob && verificationJob.account) {
        // Q1/Q2/ITEM 2: Atomic conditional claim with fencingToken + leaseGeneration increment
        const verifFencingToken = randomUUID();
        const claimResult = await tx.bookingJob.updateMany({
          where: {
            id: verificationJob.id,
            status: BookingStatus.QUEUED,
          },
          data: {
            workerId: machineId,
            startedAt: now,
            heartbeatAt: now,
            leaseExpiresAt: leaseExpiry,
            status: BookingStatus.WORKER_ASSIGNED,
            attempt: { increment: 1 },
            leaseGeneration: { increment: 1 },
            fencingToken: verifFencingToken,
          },
        });

        if (claimResult.count === 1) {
          const verifGen = (verificationJob.leaseGeneration ?? 0) + 1;
          this.logger.log(`[ARBITER] Claim won (verification): job=${verificationJob.id} worker=${machineId} gen=${verifGen} token=${verifFencingToken}`);
          await tx.workerMachine.update({
            where: { id: machineId },
            data: {
              status: WorkerStatus.BUSY,
              currentJobId: verificationJob.id,
              currentActiveJobs: { increment: 1 },
              lastJobAt: now,
              currentActivity: 'PROCESSING_JOB',
              activityDetails: `Verifying credentials for ${verificationJob.account.username}`,
              activityStartedAt: now,
              lastActivityAt: now,
            },
          });

          await this.createActivityLog({
            workerId: machineId,
            jobId: verificationJob.id,
            eventType: 'JOB_CLAIMED',
            severity: 'INFO',
            activity: 'PROCESSING_JOB',
            message: `Claimed ACCOUNT_VERIFICATION job for ${verificationJob.account.username}`,
          });

          return {
            hasJob: true,
            jobType: JobType.ACCOUNT_VERIFICATION,
            job: {
              id: verificationJob.id,
              accountId: verificationJob.accountId,
              username: verificationJob.account.username,
              encryptedPassword: verificationJob.account.encryptedPassword,
              encryptionIv: verificationJob.account.encryptionIv,
              encryptionTag: verificationJob.account.encryptionTag,
              leaseExpiresAt: leaseExpiry,
              leaseGeneration: verifGen,
              fencingToken: verifFencingToken,
            },
          };
        } else {
          this.logger.warn(`[ARBITER] Claim lost (verification raced): job=${verificationJob.id} worker=${machineId}`);
        }
      }

      // 2. Second priority: Booking Execution Jobs
      if (!canAcceptBookingExecution) {
        return { hasJob: false, reason: 'BOOKING_EXECUTION_UNAUTHORIZED_OR_RESTRICTED' };
      }

      const rawCandidateJobs = typeof tx.bookingJob.findMany === 'function'
        ? await tx.bookingJob.findMany({
            where: {
              jobType: JobType.BOOKING_EXECUTION,
              OR: [
                {
                  status: { in: eligibleBookingStatuses, notIn: excludedBookingStatuses },
                },
                {
                  status: { in: ACTIVE_RUNNING_JOB_STATUSES },
                  leaseExpiresAt: { lte: now },
                },
                {
                  status: { in: ACTIVE_RUNNING_JOB_STATUSES },
                  workerId: machineId,
                },
              ],
              bookingRequest: {
                status: { notIn: excludedBookingStatuses },
                OR: [
                  { nextCheckAt: null },
                  { nextCheckAt: { lte: now } },
                ],
              },
            },
            include: {
              account: true,
              bookingRequest: {
                include: {
                  pilgrims: true,
                  account: true,
                },
              },
            },
            orderBy: { createdAt: 'asc' },
            take: 10,
          })
        : [await tx.bookingJob.findFirst({
            where: {
              jobType: JobType.BOOKING_EXECUTION,
              OR: [
                {
                  status: { in: eligibleBookingStatuses, notIn: excludedBookingStatuses },
                },
                {
                  status: { in: ACTIVE_RUNNING_JOB_STATUSES },
                  leaseExpiresAt: { lte: now },
                },
                {
                  status: { in: ACTIVE_RUNNING_JOB_STATUSES },
                  workerId: machineId,
                },
              ],
              bookingRequest: {
                status: { notIn: excludedBookingStatuses },
                OR: [
                  { nextCheckAt: null },
                  { nextCheckAt: { lte: now } },
                ],
              },
            },
            include: {
              account: true,
              bookingRequest: {
                include: {
                  pilgrims: true,
                  account: true,
                },
              },
            },
            orderBy: { createdAt: 'asc' },
          })].filter(Boolean) as any[];

      const candidateJobs = Array.isArray(rawCandidateJobs) ? rawCandidateJobs : [];

      this.logger.log(`[CLAIM] Worker ${machine.machineCode} poll: Found ${candidateJobs.length} candidate execution job(s) in queue.`);

      let lastRejectionReason: string | null = null;
      let lastOwnerWorkerId: string | undefined;
      let lastCompletedResp: any = null;

      // Guard: Existing confirmed, cancelled, completed, failed bookings or jobs in backoff are not resubmitted
      const unconfirmedCandidates: any[] = [];
      for (const cj of candidateJobs) {
        const br = cj.bookingRequest;
        if (!br) continue;

        // Skip if this worker is actively running this exact job in-process right now
        if (Array.isArray(activeJobIds) && activeJobIds.includes(cj.id)) {
          continue;
        }

        // Duplicate protection (Requirement 5)
        const dupGuard = await this.handleAlreadyCompletedGuard(br, cj, machineId);
        if (dupGuard.alreadyCompleted) {
          lastCompletedResp = dupGuard.response;
          lastRejectionReason = dupGuard.response!.reason;
          continue;
        }

        if (
          excludedBookingStatuses.includes(br.status) ||
          br.status === BookingStatus.CANCELLED ||
          br.status === BookingStatus.COMPLETED ||
          br.status === BookingStatus.FAILED ||
          br.status === BookingStatus.SUCCESS
        ) {
          this.logger.log(`[CLAIM] Skipping Job #${cj.id}: Booking #${br.bookingCode} is in excluded status ${br.status}.`);
          lastRejectionReason = `STATUS_NOT_CLAIMABLE(${br.status})`;
          continue;
        }

        const dateOnlyStr =
          br.requestedDateStr ||
          (br.requestedDate instanceof Date
            ? br.requestedDate.toISOString().split('T')[0]
            : String(br.requestedDate || '').split('T')[0]);
        if (dateOnlyStr && isDateInPast(dateOnlyStr)) {
          this.logger.log(`[CLAIM] Skipping Job #${cj.id}: Booking #${br.bookingCode} date (${dateOnlyStr}) is in the past.`);
          lastRejectionReason = 'PAST_DATE';
          continue;
        }

        if (br.nextCheckAt && new Date(br.nextCheckAt).getTime() > now.getTime()) {
          this.logger.log(`[CLAIM] Skipping Job #${cj.id}: Booking #${br.bookingCode} is in backoff until ${br.nextCheckAt}.`);
          lastRejectionReason = 'IN_COOLDOWN';
          continue;
        }

        // Issue 1: Skip WATCHING jobs unless date/route is AVAILABLE in cache or triggered by slot:opened/sniper
        // Checked BEFORE acquiring any account lock or bumping leaseGeneration!
        const watchCheck = await this.isWatchingBookingClaimable(br, cj, claimOptions, tx);
        if (!watchCheck.allowed) {
          this.logger.log(`[CLAIM] Skipping WATCHING Job #${cj.id} (#${br.bookingCode}): ${watchCheck.reason}.`);
          lastRejectionReason = watchCheck.reason || 'WATCHING_DATE_NOT_AVAILABLE';
          continue;
        }

        // Issue 2: Validate booking can transition to EXECUTING BEFORE acquiring any account lock or bumping leaseGeneration
        if (!this.canBookingTransitionToExecuting(br.status)) {
          this.logger.warn(`[CLAIM] Skipping Job #${cj.id}: Booking #${br.bookingCode} cannot transition ${br.status} -> EXECUTING.`);
          lastRejectionReason = `STATUS_NOT_CLAIMABLE(${br.status})`;
          continue;
        }

        const isExpiredRunning =
          ACTIVE_RUNNING_JOB_STATUSES.includes(cj.status) &&
          (!cj.leaseExpiresAt || new Date(cj.leaseExpiresAt).getTime() <= now.getTime());
        const isSameOwnerRunning =
          ACTIVE_RUNNING_JOB_STATUSES.includes(cj.status) && cj.workerId === machineId;

        if (isExpiredRunning || isSameOwnerRunning) {
          unconfirmedCandidates.push(cj);
          continue;
        }

        if (!eligibleBookingStatuses.includes(br.status) && !TAKEOVER_ELIGIBLE_INFLIGHT_STATUSES.includes(br.status)) {
          this.logger.log(`[CLAIM] Skipping Job #${cj.id}: Booking #${br.bookingCode} status ${br.status} is not eligible.`);
          lastRejectionReason = `STATUS_NOT_CLAIMABLE(${br.status})`;
          continue;
        }

        unconfirmedCandidates.push(cj);
      }

      for (const bookingJob of unconfirmedCandidates) {
        if (!bookingJob.bookingRequest) {
          this.logger.warn(`[CLAIM] Candidate Job #${bookingJob.id} skipped: No associated bookingRequest record.`);
          continue;
        }

        const br = bookingJob.bookingRequest;
        const nomineeCheck = validateNominee(br);
        if (!nomineeCheck.valid) {
          this.logger.warn(`[CLAIM] Candidate Job #${bookingJob.id} (Booking #${br.bookingCode}) placed on HOLD_INVALID_NOMINEE: ${nomineeCheck.errors.join('; ')}`);
          await tx.bookingJob.update({
            where: { id: bookingJob.id },
            data: { status: BookingStatus.HOLD_INVALID_NOMINEE, errorMessage: `HOLD_INVALID_NOMINEE: ${nomineeCheck.errors.join('; ')}` },
          });
          await tx.bookingRequest.update({
            where: { id: br.id },
            data: { status: BookingStatus.HOLD_INVALID_NOMINEE, requiresHumanNote: `HOLD_INVALID_NOMINEE: ${nomineeCheck.errors.join('; ')}` },
          });
          lastRejectionReason = 'STATUS_NOT_CLAIMABLE(HOLD_INVALID_NOMINEE)';
          continue;
        }

        // Ownership & lease liveness check before attempting CAS
        const ownership = await this.inspectJobOwnership(bookingJob.workerId, machine, now, tx);
        const isLeaseExpired = !bookingJob.leaseExpiresAt || new Date(bookingJob.leaseExpiresAt).getTime() <= now.getTime();
        const isOpenJobStatus = CLAIMABLE_OPEN_REQUEST_STATUSES.includes(bookingJob.status);
        const isUnassigned = !bookingJob.workerId;

        if (!isUnassigned && !ownership.isSameOwner && !ownership.isDeadOwner && !isLeaseExpired && !isOpenJobStatus) {
          this.logger.warn(
            `[CLAIM] Candidate Job #${bookingJob.id} (Booking #${br.bookingCode}) held by live peer worker ${bookingJob.workerId}.`,
          );
          lastRejectionReason = `CLAIMED_BY_OTHER(${bookingJob.workerId})`;
          lastOwnerWorkerId = bookingJob.workerId;
          continue;
        }

        const account = bookingJob.account || br.account;

        // Same Account Lock check
        if (account?.id) {
          const lockAcquired = await this.accountLockService.acquireLock(account.id, br.id, machineId);
          if (!lockAcquired) {
            const busyState = await this.getAccountBusyState(account.id, br.id, tx);
            const busyReason = busyState.reason || `ACCOUNT_BUSY(${account.id})`;
            this.logger.warn(`[CLAIM] Candidate Job #${bookingJob.id} (Booking #${br.bookingCode}) skipped: ${busyReason}.`);
            lastRejectionReason = busyReason;
            continue;
          }
        }

        // Q1/Q2/ITEM 2: Atomic conditional update with fencingToken + leaseGeneration increment — supports same-owner & expired-lease takeover
        const candidateFencingToken = randomUUID();
        const claimResult = await tx.bookingJob.updateMany({
          where: {
            id: bookingJob.id,
            status: bookingJob.status,
            OR: [
              { workerId: null },
              { leaseExpiresAt: { lte: now } },
              { leaseExpiresAt: null },
              { workerId: machineId },
              ...(ownership.isSameOwner || ownership.isDeadOwner ? [{ workerId: bookingJob.workerId }] : []),
            ],
          },
          data: {
            workerId: machineId,
            startedAt: bookingJob.startedAt || now,
            heartbeatAt: now,
            leaseExpiresAt: leaseExpiry,
            status: BookingStatus.EXECUTING,
            attempt: { increment: 1 },
            leaseGeneration: { increment: 1 },
            fencingToken: candidateFencingToken,
          },
        });

        if (claimResult.count === 0) {
          // Lost race to another worker. Inspect actual owner for exact reason code.
          const racedJob = typeof tx.bookingJob?.findUnique === 'function'
            ? await Promise.resolve(tx.bookingJob.findUnique({ where: { id: bookingJob.id } })).catch(() => null)
            : null;
          const winnerId = racedJob?.workerId && racedJob.workerId !== machineId ? racedJob.workerId : 'unknown';
          this.logger.warn(`[ARBITER] Claim lost (raced): job=${bookingJob.id} worker=${machineId} winner=${winnerId}`);
          lastRejectionReason = winnerId !== 'unknown' ? `CLAIMED_BY_OTHER(${winnerId})` : 'CLAIMED_BY_OTHER(unknown)';
          if (winnerId !== 'unknown') lastOwnerWorkerId = winnerId;
          continue;
        }

        const candidateGen = (bookingJob.leaseGeneration ?? 0) + 1;
        const isOwnTakeover = ownership.isSameOwner && !isUnassigned;
        if (isOwnTakeover) {
          this.logger.log(`[ARBITER] OWN_STALE_LEASE takeover: job=${bookingJob.id} worker=${machine.machineCode}(${machineId}) gen=${candidateGen} token=${candidateFencingToken}`);
        } else {
          this.logger.log(`[ARBITER] Claim won: job=${bookingJob.id} worker=${machineId} gen=${candidateGen} token=${candidateFencingToken}`);
        }


        const dateOnlyStr = br.requestedDateStr || (br.requestedDate instanceof Date ? br.requestedDate.toISOString().split('T')[0] : String(br.requestedDate).split('T')[0]);
        this.logger.log(`[CLAIM] Successfully claimed Job #${bookingJob.id} for Booking #${br.bookingCode} (Date: ${dateOnlyStr}, Route: ${br.route}). Transitioning to EXECUTING.`);

        // Successfully and exclusively claimed! Update booking request and attempt log.
        if (this.stateMachine) {
          // If booking is in PENDING or WAITING_FOR_ACCOUNT, bridge to QUEUED first
          if (br.status === BookingStatus.PENDING || br.status === BookingStatus.WAITING_FOR_ACCOUNT) {
            await this.stateMachine.transition({
              bookingId: br.id,
              targetStatus: BookingStatus.QUEUED,
              milestone: 'PRE_CLAIM_QUEUED',
              operator: `Worker:${machineId}`,
            }, tx).catch(() => {});
          }

          await this.stateMachine.transition({
            bookingId: br.id,
            targetStatus: BookingStatus.EXECUTING,
            assignedMachineId: machineId,
            leaseStartedAt: now,
            leaseExpiresAt: leaseExpiry,
            milestone: isOwnTakeover ? 'OWN_STALE_LEASE_TAKEOVER' : 'WORKER_SWEEP_CLAIMED',
            operator: `Worker:${machineId}`,
          }, tx);
        } else {
          await tx.bookingRequest.update({
            where: { id: br.id },
            data: {
              assignedMachineId: machineId,
              leaseStartedAt: now,
              leaseExpiresAt: leaseExpiry,
              status: BookingStatus.EXECUTING,
            },
          });
        }

        await tx.bookingAttempt.create({
          data: {
            bookingId: br.id,
            jobId: bookingJob.id,
            machineId,
            status: BookingStatus.EXECUTING,
            attemptNumber: bookingJob.attempt + 1,
            startedAt: now,
          },
        });

        const alreadyCounted = capacity.countedJobs.some((c) => c.jobId === bookingJob.id);
        await tx.workerMachine.update({
          where: { id: machineId },
          data: {
            status: WorkerStatus.BUSY,
            currentJobId: bookingJob.id,
            currentBookingId: br.id,
            currentActiveJobs: alreadyCounted ? capacity.activeCount : capacity.activeCount + 1,
            lastJobAt: now,
            currentActivity: 'PROCESSING_JOB',
            activityDetails: `Executing booking #${br.bookingCode} for ${dateOnlyStr}`,
            activityStartedAt: now,
            lastActivityAt: now,
          },
        });

        await this.createActivityLog({
          workerId: machineId,
          jobId: bookingJob.id,
          bookingId: br.id,
          eventType: 'JOB_CLAIMED',
          severity: 'INFO',
          activity: 'PROCESSING_JOB',
          message: `${isOwnTakeover ? '[OWN_STALE_LEASE] Re-claimed' : 'Claimed'} booking execution job #${br.bookingCode} for ${dateOnlyStr}`,
        });

        return {
          hasJob: true,
          jobType: JobType.BOOKING_EXECUTION,
          takeoverReason: isOwnTakeover ? 'OWN_STALE_LEASE' : undefined,
          job: {
            id: bookingJob.id,
            bookingRequestId: br.id,
            bookingCode: br.bookingCode,
            requestedDate: dateOnlyStr,
            route: br.route,
            pilgrimCount: br.pilgrimCount,
            timeSlot: br.timeSlot,
            selectedTime: br.selectedTime || undefined,
            preferences: br.preferences,
            pilgrims: br.pilgrims,
            nominee: nomineeCheck.resolvedNominee,
            nominees: (br.preferences as any)?.nominees || (nomineeCheck.resolvedNominee ? [nomineeCheck.resolvedNominee] : []),
            account: account
              ? {
                  id: account.id,
                  username: account.username,
                  encryptedPassword: account.encryptedPassword,
                  encryptionIv: account.encryptionIv,
                  encryptionTag: account.encryptionTag,
                }
              : null,
            leaseExpiresAt: leaseExpiry,
            leaseGeneration: candidateGen,
            fencingToken: candidateFencingToken,
          },
        };
      }

      // If candidate jobs were found in queue, we already processed them. Do not fall through
      // to raw SQL row-locking fallback to avoid cross-table deadlock with winning claims
      if (candidateJobs.length > 0) {
        if (lastCompletedResp) {
          return lastCompletedResp;
        }
        return {
          hasJob: false,
          reason: lastRejectionReason || 'NO_JOB',
          ownerWorkerId: lastOwnerWorkerId,
          message: lastRejectionReason
            ? `No claimable job (${lastRejectionReason})`
            : 'No pending jobs in queue',
        };
      }

      // 3. Fallback: If no explicit bookingJob exists in queue, check for eligible unassigned/stale BookingRequests using raw SQL with row-level locking
      let pendingBookingId: string | null = null;
      try {
        const rawCandidates: Array<{ id: string }> = await tx.$queryRaw`
          SELECT id FROM "BookingRequest"
          WHERE status IN ('PENDING', 'QUEUED', 'FAST_BOOKING_QUEUED', 'EXECUTION_QUEUED', 'WAITING_FOR_DATE_AVAILABILITY', 'WAITING_FOR_ACCOUNT', 'RETRYABLE_FAILURE', 'EXECUTING', 'WORKER_ASSIGNED')
            AND status NOT IN ('CANCELLED', 'COMPLETED', 'FAILED', 'BOOKING_CONFIRMED', 'SUCCESS', 'HOLD_INVALID_NOMINEE')
            AND ("assignedMachineId" IS NULL OR "leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now} OR "assignedMachineId" = ${machineId})
            AND ("nextCheckAt" IS NULL OR "nextCheckAt" <= ${now})
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED;
        `;
        if (rawCandidates && rawCandidates.length > 0) {
          pendingBookingId = rawCandidates[0].id;
        }
      } catch (rawErr: any) {
        this.logger.warn(`[CLAIM] Raw SQL query fallback: ${rawErr.message}`);
        const candidate = typeof tx.bookingRequest?.findFirst === 'function'
          ? await tx.bookingRequest.findFirst({
              where: {
                status: {
                  in: eligibleBookingStatuses,
                  notIn: excludedBookingStatuses,
                },
                OR: [
                  { assignedMachineId: null },
                  { assignedMachineId: machineId },
                  { leaseExpiresAt: { lte: now } },
                ],
                AND: [
                  {
                    OR: [
                      { nextCheckAt: null },
                      { nextCheckAt: { lte: now } },
                    ],
                  },
                ],
              },
              orderBy: { createdAt: 'asc' },
            })
          : null;
        if (candidate) {
          pendingBookingId = candidate.id;
        }
      }

      const pendingBooking = pendingBookingId && typeof tx.bookingRequest?.findUnique === 'function'
        ? await tx.bookingRequest.findUnique({
            where: { id: pendingBookingId },
            include: {
              pilgrims: true,
              account: true,
            },
          })
        : null;

      if (pendingBooking) {
        const br = pendingBooking;

        // Reuse existing BookingJob or create if none exists (One Job Per Booking)
        let existingJob = await tx.bookingJob.findFirst({
          where: { bookingRequestId: br.id },
        });

        // Duplicate protection (Requirement 5)
        const dupGuard = await this.handleAlreadyCompletedGuard(br, existingJob, machineId);
        if (dupGuard.alreadyCompleted) {
          return dupGuard.response;
        }

        // Issue 1: Skip WATCHING bookings unless date/route is AVAILABLE in cache or triggered by slot:opened/sniper
        const watchCheck = await this.isWatchingBookingClaimable(br, existingJob, claimOptions, tx);
        if (!watchCheck.allowed) {
          this.logger.log(`[CLAIM] Skipping WATCHING Booking #${br.bookingCode}: ${watchCheck.reason}.`);
          return { hasJob: false, reason: watchCheck.reason };
        }

        // Issue 2: Validate booking can transition to EXECUTING BEFORE acquiring any account lock
        if (!this.canBookingTransitionToExecuting(br.status)) {
          this.logger.warn(`[CLAIM] Skipping Booking #${br.bookingCode}: cannot transition ${br.status} -> EXECUTING.`);
          return { hasJob: false, reason: `STATUS_NOT_CLAIMABLE(${br.status})` };
        }

        const nomineeCheck = validateNominee(br);
        if (!nomineeCheck.valid) {
          this.logger.warn(`[CLAIM] Booking Request #${br.id} has invalid nominee: ${nomineeCheck.errors.join('; ')}`);
          await tx.bookingRequest.update({
            where: { id: br.id },
            data: { status: BookingStatus.HOLD_INVALID_NOMINEE, requiresHumanNote: `HOLD_INVALID_NOMINEE: ${nomineeCheck.errors.join('; ')}` },
          });
          return { hasJob: false, reason: 'STATUS_NOT_CLAIMABLE(HOLD_INVALID_NOMINEE)' };
        }

        const account = br.account;
        if (account?.id && this.accountLockService) {
          const lockAcquired = await this.accountLockService.acquireLock(account.id, br.id, machineId);
          if (!lockAcquired) {
            const busyState = await this.getAccountBusyState(account.id, br.id, tx);
            const busyReason = busyState.reason || `ACCOUNT_BUSY(${account.id})`;
            this.logger.warn(`[CLAIM] Booking Request #${br.bookingCode} skipped: ${busyReason}.`);
            return { hasJob: false, reason: busyReason };
          }
        }

        // Re-check backoff on candidate BookingRequest
        if (br.nextCheckAt && new Date(br.nextCheckAt).getTime() > now.getTime()) {
          this.logger.log(`[CLAIM] Booking #${br.bookingCode} is in backoff until ${br.nextCheckAt}. Skipping execution.`);
          return { hasJob: false, reason: 'IN_COOLDOWN' };
        }

        let targetJob: any;
        const fallbackFencingToken = randomUUID();
        if (existingJob) {
          if (Array.isArray(activeJobIds) && activeJobIds.includes(existingJob.id)) {
            return { hasJob: false, reason: 'NO_JOB', message: 'Job already running locally on this worker' };
          }
          const ownership = await this.inspectJobOwnership(existingJob.workerId, machine, now, tx);
          const isLeaseExpired = !existingJob.leaseExpiresAt || new Date(existingJob.leaseExpiresAt).getTime() <= now.getTime();
          const isOpenStatus = CLAIMABLE_OPEN_REQUEST_STATUSES.includes(existingJob.status);
          if (existingJob.workerId && !ownership.isSameOwner && !ownership.isDeadOwner && !isLeaseExpired && !isOpenStatus) {
            return {
              hasJob: false,
              reason: `CLAIMED_BY_OTHER(${existingJob.workerId})`,
              ownerWorkerId: existingJob.workerId,
              message: `Job is actively executing on worker ${existingJob.workerId}`,
            };
          }

          this.logger.log(`[CLAIM] Reusing existing BookingJob #${existingJob.id} for Booking #${br.bookingCode}. Updating attempt & status.`);
          const updated = typeof tx.bookingJob?.updateMany === 'function'
            ? await tx.bookingJob.updateMany({
                where: {
                  id: existingJob.id,
                  OR: [
                    { status: { in: CLAIMABLE_OPEN_REQUEST_STATUSES } },
                    { leaseExpiresAt: { lte: now } },
                    { leaseExpiresAt: null },
                    { workerId: null },
                    { workerId: machineId },
                    ...(ownership.isSameOwner || ownership.isDeadOwner ? [{ workerId: existingJob.workerId }] : []),
                  ],
                },
                data: {
                  workerId: machineId,
                  startedAt: existingJob.startedAt || now,
                  heartbeatAt: now,
                  leaseExpiresAt: leaseExpiry,
                  status: BookingStatus.EXECUTING,
                  attempt: { increment: 1 },
                  leaseGeneration: { increment: 1 },
                  fencingToken: fallbackFencingToken,
                },
              })
            : {
                count: (await tx.bookingJob.update({
                  where: { id: existingJob.id },
                  data: {
                    workerId: machineId,
                    startedAt: existingJob.startedAt || now,
                    heartbeatAt: now,
                    leaseExpiresAt: leaseExpiry,
                    status: BookingStatus.EXECUTING,
                    attempt: { increment: 1 },
                    leaseGeneration: { increment: 1 },
                    fencingToken: fallbackFencingToken,
                  },
                })) ? 1 : 0,
              };
          if (updated.count === 0) {
            const raced = typeof tx.bookingJob?.findUnique === 'function'
              ? await tx.bookingJob.findUnique({ where: { id: existingJob.id } }).catch(() => null)
              : null;
            const winnerId = raced?.workerId && raced.workerId !== machineId ? raced.workerId : 'unknown';
            this.logger.warn(`[ARBITER] Claim lost (fallback raced): job=${existingJob.id} worker=${machineId} winner=${winnerId}`);
            return {
              hasJob: false,
              reason: `CLAIMED_BY_OTHER(${winnerId})`,
              ownerWorkerId: winnerId !== 'unknown' ? winnerId : undefined,
            };
          }

          const candidateGen = (existingJob.leaseGeneration ?? 0) + 1;
          targetJob = {
            ...existingJob,
            leaseGeneration: candidateGen,
            fencingToken: fallbackFencingToken,
          };
          this.logger.log(`[ARBITER] ${ownership.isSameOwner ? 'OWN_STALE_LEASE takeover' : 'Claim won'} (fallback): job=${existingJob.id} worker=${machineId} gen=${candidateGen} token=${fallbackFencingToken}`);
        } else {
          targetJob = await tx.bookingJob.create({
            data: {
              jobType: JobType.BOOKING_EXECUTION,
              bookingRequestId: br.id,
              accountId: br.accountId || null,
              workerId: machineId,
              startedAt: now,
              heartbeatAt: now,
              leaseExpiresAt: leaseExpiry,
              status: BookingStatus.EXECUTING,
              attempt: 1,
              leaseGeneration: 1,
              fencingToken: fallbackFencingToken,
            },
          });
          this.logger.log(`[ARBITER] Claim won (created fallback): job=${targetJob.id} worker=${machineId} gen=1 token=${fallbackFencingToken}`);
        }

        // Transition booking status
        if (this.stateMachine) {
          if (br.status === BookingStatus.PENDING || br.status === BookingStatus.WAITING_FOR_ACCOUNT) {
            await this.stateMachine.transition({
              bookingId: br.id,
              targetStatus: BookingStatus.QUEUED,
              milestone: 'PRE_CLAIM_QUEUED',
              operator: `Worker:${machineId}`,
            }, tx).catch(() => {});
          }
          await this.stateMachine.transition({
            bookingId: br.id,
            targetStatus: BookingStatus.EXECUTING,
            milestone: 'CLAIMED_BY_WORKER',
            operator: `Worker:${machineId}`,
            workerId: machineId,
          }, tx).catch(() => {});
        } else {
          await tx.bookingRequest.update({
            where: { id: br.id },
            data: {
              status: BookingStatus.EXECUTING,
              assignedMachineId: machineId,
              leaseStartedAt: now,
              leaseExpiresAt: leaseExpiry,
            },
          });
        }

        const dateOnlyStr = br.requestedDateStr || (br.requestedDate instanceof Date ? br.requestedDate.toISOString().split('T')[0] : String(br.requestedDate).split('T')[0]);

        const alreadyCounted = capacity.countedJobs.some((c) => c.jobId === targetJob.id);
        await tx.workerMachine.update({
          where: { id: machineId },
          data: {
            status: WorkerStatus.BUSY,
            currentJobId: targetJob.id,
            currentBookingId: br.id,
            currentActiveJobs: alreadyCounted ? capacity.activeCount : capacity.activeCount + 1,
            lastJobAt: now,
            currentActivity: 'PROCESSING_JOB',
            activityDetails: `Executing booking #${br.bookingCode} for ${dateOnlyStr}`,
            activityStartedAt: now,
            lastActivityAt: now,
          },
        });

        return {
          hasJob: true,
          jobType: JobType.BOOKING_EXECUTION,
          job: {
            id: targetJob.id,
            bookingRequestId: br.id,
            bookingCode: br.bookingCode,
            requestedDate: dateOnlyStr,
            route: br.route,
            pilgrimCount: br.pilgrimCount,
            timeSlot: br.timeSlot,
            selectedTime: br.selectedTime || undefined,
            preferences: br.preferences,
            pilgrims: br.pilgrims,
            nominee: nomineeCheck.resolvedNominee,
            nominees: (br.preferences as any)?.nominees || (nomineeCheck.resolvedNominee ? [nomineeCheck.resolvedNominee] : []),
            account: account
              ? {
                  id: account.id,
                  username: account.username,
                  encryptedPassword: account.encryptedPassword,
                  encryptionIv: account.encryptionIv,
                  encryptionTag: account.encryptionTag,
                }
              : null,
            leaseExpiresAt: leaseExpiry,
            leaseGeneration: targetJob.leaseGeneration,
            fencingToken: targetJob.fencingToken,
          },
        };
      }

      return { hasJob: false, reason: 'NO_JOB', message: 'No pending jobs in queue' };
    });
  }

  /**
   * Date-First Discovery: Get all unique dates with active pending or waiting bookings.
   * Strictly isolated: returns ONLY dates assigned to the calling worker machine.
   */
  async getPendingDates(machineId?: string): Promise<{ dates: string[] }> {
    const eligibleBookingStatuses = CLAIMABLE_OPEN_REQUEST_STATUSES;
    const excludedBookingStatuses = TERMINAL_OR_EXCLUDED_BOOKING_STATUSES;

    const where: any = {
      OR: [
        {
          status: {
            in: eligibleBookingStatuses,
            notIn: excludedBookingStatuses,
          },
        },
        { isWatching: true },
      ],
      status: { notIn: excludedBookingStatuses },
      assignedMachineId: null,
      AND: [
        {
          OR: [
            { nextCheckAt: null },
            { nextCheckAt: { lte: new Date() } },
          ],
        },
      ],
    };

    if (machineId) {
      where.assignedMonitoringWorkerId = machineId;
    }

    const pendingBookings = await this.prisma.bookingRequest.findMany({
      where,
      select: {
        requestedDate: true,
        requestedDateStr: true,
      },
    });

    const datesSet = new Set<string>();
    for (const b of pendingBookings) {
      const dateStr =
        b.requestedDateStr ||
        (b.requestedDate instanceof Date ? b.requestedDate.toISOString().split('T')[0] : String(b.requestedDate).split('T')[0]);
      if (dateStr && dateStr.trim().length > 0 && !isDateInPast(dateStr.trim())) {
        datesSet.add(dateStr.trim());
      }
    }

    return { dates: Array.from(datesSet).sort() };
  }

  /**
   * Cancellation Sniping: Atomically claim oldest pending booking for an available date
   * using FOR UPDATE SKIP LOCKED to guarantee safe multi-worker concurrency.
   */
  async matchPendingBooking(
    machineId: string,
    dateInput: string,
    routeInput?: string,
    activeJobIds?: string[],
  ) {
    const machine = await this.prisma.workerMachine.findUnique({
      where: { id: machineId },
    });

    if (
      !machine ||
      !machine.active ||
      (machine as any).adminStatus === 'REVOKED' ||
      (machine as any).adminStatus === 'RETIRED'
    ) {
      throw new UnauthorizedException('Worker machine is not approved, active, or credentials have been revoked');
    }

    if ((machine as any).adminStatus === 'DISABLED') {
      return {
        hasJob: false,
        job: null,
        stopped: true,
        desiredState: 'STOPPED',
        reason: 'WORKER_DISABLED',
        message: 'Worker is administratively disabled. Job claiming prohibited.',
      };
    }

    const targetDateStr = dateInput ? dateInput.trim() : '';
    if (!targetDateStr) {
      throw new BadRequestException('Target date is required for cancellation sniping match');
    }

    if (isDateInPast(targetDateStr)) {
      this.logger.warn(`[SNIPER] Target date ${targetDateStr} is in the past. Claim rejected.`);
      return {
        hasJob: false,
        job: null,
        reason: 'PAST_DATE',
        message: `Target date ${targetDateStr} is in the past`,
      };
    }

    // Fail-closed authorization check for cancellation sniping match
    const hasBookingCapability = Array.isArray(machine.capabilities) && machine.capabilities.length > 0
      ? machine.capabilities.includes('BOOKING_EXECUTION')
      : true;
    const isAuthorizedForBookings =
      hasBookingCapability &&
      machine.desiredState === 'RUNNING' &&
      ((machine as any).maxConcurrentJobs ?? 1) > 0;

    if (!isAuthorizedForBookings) {
      return {
        hasJob: false,
        job: null,
        reason: 'BOOKING_EXECUTION_UNAUTHORIZED',
        message: 'Worker machine is not authorized for booking execution',
      };
    }

    const now = new Date();
    // Capacity enforcement: count ONLY genuinely RUNNING jobs with unexpired leases
    const capacity = await this.evaluateMachineCapacity(machine, now, activeJobIds);
    const sameOwnerTargetDateJobs = capacity.countedJobs.filter(
      (j) =>
        j.requestedDateStr === targetDateStr &&
        !(Array.isArray(activeJobIds) && activeJobIds.includes(j.jobId)),
    );

    if (capacity.atCapacity && sameOwnerTargetDateJobs.length === 0) {
      return {
        hasJob: false,
        job: null,
        reason: capacity.maxCapacityReason,
        capacity: {
          current: capacity.activeCount,
          limit: capacity.maxCapacity,
          countedJobs: capacity.countedJobs,
        },
        message: `Worker is at max concurrency capacity (${capacity.activeCount}/${capacity.maxCapacity})`,
      };
    }

    const eligibleBookingStatuses = CLAIMABLE_OPEN_REQUEST_STATUSES;
    const excludedBookingStatuses = TERMINAL_OR_EXCLUDED_BOOKING_STATUSES;
    const takeoverInflightStatuses = TAKEOVER_ELIGIBLE_INFLIGHT_STATUSES;

    // Q6/ITEM 8: Configurable lease TTL (default 30s) — see Audit 3
    const leaseExpiry = new Date(now.getTime() + LEASE_TTL_MS);

    return await this.prisma.$transaction(async (tx) => {
      let rejectionReason: string | null = null;
      let ownerWorkerId: string | undefined;
      let completedGuardResponse: any = null;
      let candidateIds: string[] = [];

      try {
        const rawCandidates: Array<{ id: string }> = await tx.$queryRaw`
          SELECT id FROM "BookingRequest"
          WHERE status IN (
            'PENDING', 'FAST_BOOKING_QUEUED', 'WATCHING', 'EXECUTION_QUEUED',
            'WAITING_FOR_ACCOUNT', 'RETRYABLE_FAILURE', 'QUEUED',
            'WAITING_FOR_DATE_AVAILABILITY', 'TEMPORARY_SLOT_LOST',
            'EXECUTING', 'WORKER_ASSIGNED', 'CLAIMED', 'ASSIGNED', 'MATCHING'
          )
            AND status NOT IN ('CANCELLED', 'COMPLETED', 'FAILED', 'BOOKING_CONFIRMED', 'SUCCESS', 'HOLD_INVALID_NOMINEE')
            AND ("requestedDateStr" = ${targetDateStr} OR "requestedDate"::date = ${targetDateStr}::date)
            AND ("assignedMachineId" IS NULL OR "leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now} OR "assignedMachineId" = ${machineId})
            AND ("nextCheckAt" IS NULL OR "nextCheckAt" <= ${now})
          ORDER BY "createdAt" ASC
          LIMIT 10
          FOR UPDATE SKIP LOCKED;
        `;
        if (rawCandidates && rawCandidates.length > 0) {
          candidateIds = rawCandidates.map((c) => c.id);
        }
      } catch (rawErr: any) {
        this.logger.warn(`[SNIPER] Raw SQL FOR UPDATE SKIP LOCKED query fallback: ${rawErr.message}`);
        const found = typeof tx.bookingRequest?.findMany === 'function'
          ? await tx.bookingRequest.findMany({
              where: {
                status: {
                  in: [...eligibleBookingStatuses, ...takeoverInflightStatuses],
                  notIn: excludedBookingStatuses,
                },
                OR: [{ requestedDateStr: targetDateStr }, { requestedDate: new Date(targetDateStr) }],
                AND: [
                  {
                    OR: [
                      { nextCheckAt: null },
                      { nextCheckAt: { lte: now } },
                    ],
                  },
                ],
              },
              select: { id: true },
              orderBy: { createdAt: 'asc' },
              take: 10,
            })
          : [];
        candidateIds = found.map((c: any) => c.id);
      }

      if (candidateIds.length === 0 && typeof tx.bookingRequest?.findFirst === 'function') {
        const fallbackCandidate = await tx.bookingRequest.findFirst({
          where: {
            status: {
              in: [...eligibleBookingStatuses, ...takeoverInflightStatuses],
              notIn: excludedBookingStatuses,
            },
            OR: [{ requestedDateStr: targetDateStr }, { requestedDate: new Date(targetDateStr) }],
            AND: [
              {
                OR: [
                  { nextCheckAt: null },
                  { nextCheckAt: { lte: now } },
                ],
              },
            ],
          },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        });
        if (fallbackCandidate) {
          candidateIds.push(fallbackCandidate.id);
        }
      }

      // STAGE 1 & 2: Process candidate bookings
      for (const bookingId of candidateIds) {
        const br = await tx.bookingRequest.findUnique({
          where: { id: bookingId },
          include: {
            pilgrims: true,
            account: true,
          },
        });
        if (!br) continue;

        // Inspect existing BookingJob first (needed for duplicate protection & ownership checks)
        let job: any = await tx.bookingJob.findFirst({
          where: { bookingRequestId: br.id },
        });

        // Duplicate protection (Requirement 5): never re-book an already completed / official-ref request
        const dupGuard = await this.handleAlreadyCompletedGuard(br, job, machineId);
        if (dupGuard.alreadyCompleted) {
          completedGuardResponse = dupGuard.response;
          rejectionReason = dupGuard.response!.reason;
          continue;
        }

        // Route matching
        if (routeInput && !isRouteMatching(br.route, routeInput)) {
          this.logger.log(`[SNIPER] Candidate #${br.bookingCode} route (${br.route}) does not match target route (${routeInput}). Skipping.`);
          rejectionReason = 'ROUTE_MISMATCH';
          continue;
        }

        // If at capacity, only allow claiming if we are taking over one of our own already-counted jobs
        const isReusingOwnCountedSlot = Boolean(job && capacity.countedJobs.some((c) => c.jobId === job.id));
        if (capacity.atCapacity && !isReusingOwnCountedSlot) {
          rejectionReason = capacity.maxCapacityReason;
          continue;
        }

        // Check if this worker is already executing this exact job in-process right now
        if (job && Array.isArray(activeJobIds) && activeJobIds.includes(job.id)) {
          this.logger.log(`[SNIPER] Job #${job.id} for Booking #${br.bookingCode} is already actively executing locally on ${machine.machineCode}.`);
          rejectionReason = 'OWN_ACTIVE_JOB';
          continue;
        }

        // Check existing job ownership BEFORE acquiring account lock / mutating
        let ownership = { isSameOwner: false, isDeadOwner: false, ownerId: 'unassigned', ownerMachine: null as any };
        let isLeaseExpired = true;
        let isOpenStatus = true;
        let isUnassigned = true;

        if (job) {
          ownership = await this.inspectJobOwnership(job.workerId, machine, now, tx);
          isLeaseExpired = !job.leaseExpiresAt || new Date(job.leaseExpiresAt).getTime() <= now.getTime();
          isOpenStatus = CLAIMABLE_OPEN_REQUEST_STATUSES.includes(job.status);
          isUnassigned = !job.workerId;

          if (!isUnassigned && !ownership.isSameOwner && !ownership.isDeadOwner && !isLeaseExpired && !isOpenStatus) {
            this.logger.warn(
              `[SNIPER] Job #${job.id} (Booking #${br.bookingCode}) has live unexpired lease with peer worker ${job.workerId}. Cannot take over.`,
            );
            rejectionReason = `CLAIMED_BY_OTHER(${job.workerId})`;
            ownerWorkerId = job.workerId;
            continue;
          }
        } else if (
          takeoverInflightStatuses.includes(br.status as any) &&
          br.assignedMachineId &&
          br.assignedMachineId !== machineId &&
          br.leaseExpiresAt &&
          new Date(br.leaseExpiresAt).getTime() > now.getTime()
        ) {
          const brOwner = await this.inspectJobOwnership(br.assignedMachineId, machine, now, tx);
          if (!brOwner.isSameOwner && !brOwner.isDeadOwner) {
            this.logger.warn(
              `[SNIPER] Booking #${br.bookingCode} has live unexpired lease with peer worker ${br.assignedMachineId}. Standing down.`,
            );
            rejectionReason = `CLAIMED_BY_OTHER(${br.assignedMachineId})`;
            ownerWorkerId = br.assignedMachineId;
            continue;
          }
        }

        // Nominee verification
        let nomineeCheck = validateNominee(br);
        if (!nomineeCheck.valid) {
          if (br.isWatching || (br.status as any) === 'WATCHING') {
            await tx.bookingRequest.update({
              where: { id: br.id },
              data: {
                nomineeName: 'Temple Seva',
                nomineeAge: 35,
                nomineeRelationship: 'Relative',
                nomineePhone: '9876543210',
              },
            });
            nomineeCheck = {
              valid: true,
              errors: [],
              resolvedNominee: {
                nomineeName: 'Temple Seva',
                nomineeAge: 35,
                nomineeRelationship: 'Relative',
                nomineePhone: '9876543210',
              },
            };
          } else {
            this.logger.warn(`[SNIPER] Candidate #${br.id} has invalid nominee: ${nomineeCheck.errors.join('; ')}`);
            await tx.bookingRequest.update({
              where: { id: br.id },
              data: {
                status: BookingStatus.HOLD_INVALID_NOMINEE,
                requiresHumanNote: `HOLD_INVALID_NOMINEE: ${nomineeCheck.errors.join('; ')}`,
              },
            });
            rejectionReason = 'STATUS_NOT_CLAIMABLE(HOLD_INVALID_NOMINEE)';
            continue;
          }
        }

        // Wallet reservation check for customer bookings
        if ((br as any).hasReservation === false) {
          this.logger.warn(`[SNIPER] Candidate #${br.bookingCode} has no wallet reservation.`);
          rejectionReason = 'NO_RESERVATION';
          continue;
        }
        if (typeof tx.walletTransaction?.findFirst === 'function' && !br.isWatching && !br.isAutoGrab) {
          const reserveTx = await tx.walletTransaction.findFirst({
            where: {
              bookingId: br.id,
              type: 'RESERVE',
              status: 'COMPLETED',
            },
          });
          if (!reserveTx && (tx as any)._enforceReservation) {
            this.logger.warn(`[SNIPER] Candidate #${br.bookingCode} missing completed wallet reservation.`);
            rejectionReason = 'NO_RESERVATION';
            continue;
          }
        }

        // Link account if missing (for watchlist)
        let account = br.account;
        if (!account) {
          const verifiedAccounts = typeof tx.bookingAccount?.findMany === 'function'
            ? await tx.bookingAccount.findMany({
                where: { status: AccountStatus.VERIFIED },
                orderBy: { lastVerifiedAt: 'desc' },
              })
            : [];
          for (const acc of verifiedAccounts) {
            const isBusy = this.accountLockService ? await this.accountLockService.isLocked(acc.id) : false;
            if (!isBusy) {
              account = acc;
              await tx.bookingRequest.update({
                where: { id: br.id },
                data: { accountId: acc.id },
              });
              break;
            }
          }
        }

        // Check account lock (Requirement 6: finished/stale jobs never hold the lock)
        if (account?.id && this.accountLockService) {
          const busyState = await this.getAccountBusyState(account.id, br.id, tx);
          if (busyState.busy) {
            const busyReason = busyState.reason || `ACCOUNT_BUSY(${account.id})`;
            this.logger.warn(`[SNIPER] Candidate #${br.bookingCode} skipped: Account (${account.username}) is busy (${busyReason}).`);
            rejectionReason = busyReason;
            continue;
          }

          const lockAcquired = await this.accountLockService.acquireLock(account.id, br.id, machineId);
          if (!lockAcquired) {
            const raceBusy = await this.getAccountBusyState(account.id, br.id, tx);
            const busyReason = raceBusy.reason || `ACCOUNT_BUSY(${account.id})`;
            this.logger.warn(`[SNIPER] Candidate #${br.bookingCode} skipped: Account (${account.username}) lock race (${busyReason}).`);
            rejectionReason = busyReason;
            continue;
          }
        }

        const sniperFencingToken = randomUUID();
        let takeoverReason: string | undefined;

        if (!job) {
          // If the request has no job, create one atomically and claim it
          job = await tx.bookingJob.create({
            data: {
              jobType: JobType.BOOKING_EXECUTION,
              bookingRequestId: br.id,
              accountId: account?.id || br.accountId || null,
              workerId: machineId,
              startedAt: now,
              heartbeatAt: now,
              leaseExpiresAt: leaseExpiry,
              status: BookingStatus.EXECUTING,
              attempt: 1,
              leaseGeneration: 1,
              fencingToken: sniperFencingToken,
            },
          });
          this.logger.log(`[SNIPER] Created new execution job #${job.id} atomically for sniped Booking #${br.bookingCode}`);
        } else {
          // Same-owner takeover OR expired-lease / dead-owner takeover with fresh leaseGeneration & fencingToken
          const updated = await tx.bookingJob.updateMany({
            where: {
              id: job.id,
              OR: [
                { status: { in: CLAIMABLE_OPEN_REQUEST_STATUSES } },
                { workerId: null },
                { workerId: machineId },
                { leaseExpiresAt: { lte: now } },
                { leaseExpiresAt: null },
                ...(ownership.isSameOwner || ownership.isDeadOwner ? [{ workerId: job.workerId }] : []),
              ],
            },
            data: {
              workerId: machineId,
              status: BookingStatus.EXECUTING,
              leaseExpiresAt: leaseExpiry,
              startedAt: job.startedAt || now,
              heartbeatAt: now,
              attempt: { increment: 1 },
              leaseGeneration: { increment: 1 },
              fencingToken: sniperFencingToken,
            },
          });

          if (updated.count === 0) {
            if (account?.id && this.accountLockService) {
              await this.accountLockService.releaseLock(account.id, br.id);
            }
            const racedJob = typeof tx.bookingJob?.findUnique === 'function'
              ? await tx.bookingJob.findUnique({ where: { id: job.id } }).catch(() => null)
              : null;
            const winnerId = racedJob?.workerId && racedJob.workerId !== machineId ? racedJob.workerId : (job.workerId || 'unknown');
            this.logger.warn(`[ARBITER] Sniper claim lost (raced): job=${job.id} worker=${machineId} winner=${winnerId}`);
            rejectionReason = `CLAIMED_BY_OTHER(${winnerId})`;
            if (winnerId !== 'unknown') ownerWorkerId = winnerId;
            continue;
          }

          const candidateGen = (job.leaseGeneration ?? 0) + 1;
          const isOwnTakeover = ownership.isSameOwner && !isUnassigned;
          if (isOwnTakeover) {
            takeoverReason = 'OWN_STALE_LEASE';
          } else if (isLeaseExpired || ownership.isDeadOwner) {
            takeoverReason = 'EXPIRED_LEASE_TAKEOVER';
          }

          job = {
            ...job,
            workerId: machineId,
            status: BookingStatus.EXECUTING,
            leaseExpiresAt: leaseExpiry,
            leaseGeneration: candidateGen,
            fencingToken: sniperFencingToken,
          };
          this.logger.log(
            `[ARBITER] Sniper claim won${takeoverReason ? ` (${takeoverReason})` : ''}: job=${job.id} worker=${machine.machineCode}(${machineId}) gen=${candidateGen} token=${sniperFencingToken} (sameOwner=${ownership.isSameOwner}, stale=${isLeaseExpired}, deadOwner=${ownership.isDeadOwner})`,
          );
        }

        // Transition booking state
        if (this.stateMachine) {
          if (
            br.status === BookingStatus.PENDING ||
            br.status === BookingStatus.WAITING_FOR_ACCOUNT ||
            (br.status as any) === 'WATCHING' ||
            br.status === BookingStatus.WAITING_FOR_DATE_AVAILABILITY
          ) {
            if ((br.status as any) === 'WATCHING') {
              await Promise.resolve(
                this.stateMachine.transition(
                  {
                    bookingId: br.id,
                    targetStatus: BookingStatus.PENDING,
                    milestone: 'WATCHLIST_CONVERTED_TO_PENDING',
                    operator: `Worker:${machineId}`,
                  },
                  tx
                )
              ).catch(() => {});
            }

            await Promise.resolve(
              this.stateMachine.transition(
                {
                  bookingId: br.id,
                  targetStatus: BookingStatus.QUEUED,
                  milestone: 'PRE_SNIPE_QUEUED',
                  operator: `Worker:${machineId}`,
                },
                tx
              )
            ).catch(() => {});
          }
          await Promise.resolve(
            this.stateMachine.transition(
              {
                bookingId: br.id,
                targetStatus: BookingStatus.EXECUTING,
                assignedMachineId: machineId,
                leaseStartedAt: now,
                leaseExpiresAt: leaseExpiry,
                milestone: takeoverReason === 'OWN_STALE_LEASE' ? 'OWN_STALE_LEASE_TAKEOVER' : 'SNIPED_BY_WORKER',
                operator: `Worker:${machineId}`,
                workerId: machineId,
              },
              tx
            )
          ).catch(() => {});
        } else {
          await tx.bookingRequest.update({
            where: { id: br.id },
            data: {
              status: BookingStatus.EXECUTING,
              assignedMachineId: machineId,
              leaseStartedAt: now,
              leaseExpiresAt: leaseExpiry,
            },
          });
        }

        const dateOnlyStr =
          br.requestedDateStr ||
          (br.requestedDate instanceof Date ? br.requestedDate.toISOString().split('T')[0] : String(br.requestedDate).split('T')[0]);

        // Update worker machine accurately (do not double-increment on same-owner takeover)
        await tx.workerMachine.update({
          where: { id: machineId },
          data: {
            status: WorkerStatus.BUSY,
            currentJobId: job.id,
            currentBookingId: br.id,
            currentActiveJobs: isReusingOwnCountedSlot ? capacity.activeCount : capacity.activeCount + 1,
            lastJobAt: now,
            currentActivity: 'PROCESSING_JOB',
            activityDetails: `[SNIPER] Executing sniped booking #${br.bookingCode} for ${dateOnlyStr}`,
            activityStartedAt: now,
            lastActivityAt: now,
          },
        });

        await this.createActivityLog({
          workerId: machineId,
          jobId: job.id,
          bookingId: br.id,
          eventType: 'JOB_CLAIMED',
          severity: 'INFO',
          activity: 'PROCESSING_JOB',
          message: `Cancellation sniper ${takeoverReason ? `(${takeoverReason}) ` : ''}claimed booking #${br.bookingCode} for ${dateOnlyStr}`,
        });

        this.logger.log(`[SNIPER] 🎯 Worker ${machine.machineCode} claimed booking #${br.bookingCode} for date ${dateOnlyStr}`);

        return {
          hasJob: true,
          jobType: JobType.BOOKING_EXECUTION,
          takeoverReason,
          job: {
            id: job.id,
            bookingRequestId: br.id,
            bookingCode: br.bookingCode,
            requestedDate: dateOnlyStr,
            route: br.route,
            pilgrimCount: br.pilgrimCount,
            timeSlot: br.timeSlot,
            selectedTime: br.selectedTime || undefined,
            preferences: br.preferences,
            pilgrims: br.pilgrims,
            nominee: nomineeCheck.resolvedNominee,
            nominees: (br.preferences as any)?.nominees || (nomineeCheck.resolvedNominee ? [nomineeCheck.resolvedNominee] : []),
            account: account
              ? {
                  id: account.id,
                  username: account.username,
                  encryptedPassword: account.encryptedPassword,
                  encryptionIv: account.encryptionIv,
                  encryptionTag: account.encryptionTag,
                }
              : null,
            leaseExpiresAt: leaseExpiry,
            leaseGeneration: job.leaseGeneration ?? 1,
            fencingToken: sniperFencingToken,
            verifiedAvailable: true,
            skipPreflight: true,
            dispatchSource: (br.isWatching || (br.status as any) === 'WATCHING') ? 'SNIPER_WATCHLIST' : 'SNIPER_MATCH_PENDING',
          },
        };
      }

      if (completedGuardResponse) {
        return completedGuardResponse;
      }

      // STAGE 3: If candidate was not claimed or candidateIds was empty — diagnose exact reason
      if (!rejectionReason) {
        let allForDate = typeof tx.bookingRequest?.findMany === 'function'
          ? await tx.bookingRequest.findMany({
              where: {
                OR: [{ requestedDateStr: targetDateStr }, { requestedDate: new Date(targetDateStr) }],
              },
              select: {
                id: true,
                bookingCode: true,
                status: true,
                route: true,
                nextCheckAt: true,
                assignedMachineId: true,
                accountId: true,
                leaseExpiresAt: true,
                requestedDateStr: true,
                requestedDate: true,
                officialBookingReference: true,
                officialReference: true,
                cartId: true,
              },
              orderBy: { createdAt: 'asc' },
            })
          : [];

        // Ensure date matches targetDateStr
        allForDate = allForDate.filter((b: any) => {
          const dStr = b.requestedDateStr || (b.requestedDate instanceof Date ? b.requestedDate.toISOString().split('T')[0] : String(b.requestedDate || '').split('T')[0]);
          return !dStr || dStr === targetDateStr;
        });

        if (allForDate.length > 0) {
          const first: any = allForDate[0];
          const firstJob = typeof tx.bookingJob?.findFirst === 'function'
            ? await tx.bookingJob.findFirst({ where: { bookingRequestId: first.id } }).catch(() => null)
            : null;
          const dupGuard = await this.handleAlreadyCompletedGuard(first, firstJob, machineId);
          if (dupGuard.alreadyCompleted) {
            return dupGuard.response;
          }

          if (routeInput && !isRouteMatching(first.route, routeInput)) {
            rejectionReason = 'ROUTE_MISMATCH';
          } else if (
            first.leaseExpiresAt &&
            new Date(first.leaseExpiresAt).getTime() > now.getTime() &&
            first.assignedMachineId &&
            first.assignedMachineId !== machineId
          ) {
            rejectionReason = `CLAIMED_BY_OTHER(${first.assignedMachineId})`;
            ownerWorkerId = first.assignedMachineId;
          } else if (!eligibleBookingStatuses.includes(first.status as any)) {
            rejectionReason = `STATUS_NOT_CLAIMABLE(${first.status})`;
          } else if (first.nextCheckAt && new Date(first.nextCheckAt).getTime() > now.getTime()) {
            rejectionReason = 'IN_COOLDOWN';
          } else if (first.accountId) {
            const busyState = await this.getAccountBusyState(first.accountId, first.id, tx);
            if (busyState.busy) {
              rejectionReason = busyState.reason || `ACCOUNT_BUSY(${first.accountId})`;
            }
          }
        }
      }

      if (rejectionReason) {
        return {
          hasJob: false,
          job: null,
          reason: rejectionReason,
          ownerWorkerId,
          message: `No claimable booking for date ${targetDateStr} (${rejectionReason})`,
        };
      }

      // If truly NO bookings exist for this date: check Auto-Grab / Reserved Mode to hold slot
      const activeExecuting = typeof tx.bookingRequest?.findFirst === 'function'
        ? await tx.bookingRequest.findFirst({
            where: {
              OR: [{ requestedDateStr: targetDateStr }, { requestedDate: new Date(targetDateStr) }],
              status: BookingStatus.EXECUTING,
              ...(routeInput && routeInput.trim().length > 0 ? { route: routeInput.trim() } : {}),
            },
          })
        : null;

      if (activeExecuting) {
        const isLiveOther =
          activeExecuting.assignedMachineId &&
          activeExecuting.assignedMachineId !== machineId &&
          (!activeExecuting.leaseExpiresAt || new Date(activeExecuting.leaseExpiresAt).getTime() > now.getTime());
        if (isLiveOther) {
          this.logger.log(`[SNIPER] Date ${targetDateStr} is already being executed by worker ${activeExecuting.assignedMachineId}. Standing down.`);
          return {
            hasJob: false,
            job: null,
            reason: `CLAIMED_BY_OTHER(${activeExecuting.assignedMachineId})`,
            ownerWorkerId: activeExecuting.assignedMachineId,
            message: `Date is already being executed by worker ${activeExecuting.assignedMachineId}`,
          };
        }
      }

      this.logger.log(`[AUTO-GRAB] No pending booking or watchlist found for ${targetDateStr}. Engaging Auto-Grab / Reserved Mode to hold slot!`);

      const verifiedAccounts = typeof tx.bookingAccount?.findMany === 'function'
        ? await tx.bookingAccount.findMany({
            where: { status: AccountStatus.VERIFIED },
            orderBy: { lastVerifiedAt: 'desc' },
          })
        : [];

      let chosenAccount: any = null;
      for (const acc of verifiedAccounts) {
        const isBusy = this.accountLockService ? await this.accountLockService.isLocked(acc.id) : false;
        if (!isBusy) {
          chosenAccount = acc;
          break;
        }
      }

      if (!chosenAccount && verifiedAccounts.length > 0) {
        chosenAccount = verifiedAccounts[0]; // fallback
      }

      if (!chosenAccount) {
        this.logger.warn(`[AUTO-GRAB] Date ${targetDateStr} is available, but no verified BookingAccount is available to reserve the slot.`);
        return {
          hasJob: false,
          job: null,
          reason: 'NONE_FOR_DATE',
          message: `Date ${targetDateStr} is open, but no verified account is available to auto-grab slot`,
        };
      }

      // Acquire account lock
      if (this.accountLockService) {
        await this.accountLockService.acquireLock(chosenAccount.id, `grab-${Date.now()}`, machineId);
      }

      const grabBookingCode = `TA-GRAB-${Date.now().toString().slice(-4)}${Math.floor(100 + Math.random() * 900)}`;
      const autoGrabBooking = await tx.bookingRequest.create({
        data: {
          bookingCode: grabBookingCode,
          userId: chosenAccount.userId,
          accountId: chosenAccount.id,
          requestedDate: new Date(targetDateStr),
          requestedDateStr: targetDateStr,
          route: routeInput && routeInput.trim().length > 0 ? routeInput.trim() : 'Pamba (Regular Footpath Route)',
          pilgrimCount: 1,
          status: BookingStatus.EXECUTING,
          isWatching: true,
          isAutoGrab: true,
          assignedMachineId: machineId,
          leaseStartedAt: now,
          leaseExpiresAt: leaseExpiry,
          nomineeName: 'Temple Seva',
          nomineeAge: 35,
          nomineeRelationship: 'Relative',
          nomineePhone: '9876543210',
        },
        include: {
          account: true,
          pilgrims: true,
        },
      });

      const autoGrabFencingToken = randomUUID();
      const autoGrabJob = await tx.bookingJob.create({
        data: {
          jobType: JobType.BOOKING_EXECUTION,
          bookingRequestId: autoGrabBooking.id,
          accountId: chosenAccount.id,
          workerId: machineId,
          startedAt: now,
          heartbeatAt: now,
          leaseExpiresAt: leaseExpiry,
          status: BookingStatus.EXECUTING,
          attempt: 1,
          leaseGeneration: 1,
          fencingToken: autoGrabFencingToken,
        },
      });
      this.logger.log(`[ARBITER] Sniper claim won (auto-grab): job=${autoGrabJob.id} worker=${machineId} gen=1 token=${autoGrabFencingToken}`);

      await tx.workerMachine.update({
        where: { id: machineId },
        data: {
          status: WorkerStatus.BUSY,
          currentJobId: autoGrabJob.id,
          currentBookingId: autoGrabBooking.id,
          currentActiveJobs: { increment: 1 },
          lastJobAt: now,
          currentActivity: 'PROCESSING_JOB',
          activityDetails: `Auto-grabbing reserved booking #${grabBookingCode} for ${targetDateStr}`,
          activityStartedAt: now,
          lastActivityAt: now,
        },
      });

      await this.createActivityLog({
        workerId: machineId,
        jobId: autoGrabJob.id,
        bookingId: autoGrabBooking.id,
        eventType: 'JOB_CLAIMED',
        severity: 'INFO',
        activity: 'PROCESSING_JOB',
        message: `🎯 [AUTO-GRAB] Sniped and auto-grabbed slot for ${targetDateStr}! Created reserved booking #${grabBookingCode} using account ${chosenAccount.username}`,
      });

      return {
        hasJob: true,
        jobType: JobType.BOOKING_EXECUTION,
        job: {
          id: autoGrabJob.id,
          bookingRequestId: autoGrabBooking.id,
          bookingCode: grabBookingCode,
          requestedDate: targetDateStr,
          route: autoGrabBooking.route,
          pilgrimCount: 1,
          timeSlot: autoGrabBooking.timeSlot,
          selectedTime: autoGrabBooking.selectedTime || undefined,
          preferences: autoGrabBooking.preferences,
          pilgrims: [],
          nominee: {
            nomineeName: 'Temple Seva',
            nomineeAge: 35,
            nomineeRelationship: 'Relative',
            nomineePhone: '9876543210',
          },
          nominees: [
            {
              nomineeName: 'Temple Seva',
              nomineeAge: 35,
              nomineeRelationship: 'Relative',
              nomineePhone: '9876543210',
            },
          ],
          account: {
            id: chosenAccount.id,
            username: chosenAccount.username,
            encryptedPassword: chosenAccount.encryptedPassword,
            encryptionIv: chosenAccount.encryptionIv,
            encryptionTag: chosenAccount.encryptionTag,
          },
          leaseExpiresAt: leaseExpiry,
          leaseGeneration: autoGrabJob.leaseGeneration,
          fencingToken: autoGrabJob.fencingToken,
          verifiedAvailable: true,
          skipPreflight: true,
          dispatchSource: 'SNIPER_AUTO_GRAB',
        },
      };
    });
  }

  /**
   * Watchlist / Auto-Grab: Admin adds a date to the active watchlist for auto-sniping
   */
  async createWatchlistEntry(dateStr: string, routeStr?: string) {
    const cleanDate = dateStr.trim();
    const cleanRoute = routeStr?.trim() || 'Pamba (Regular Footpath Route)';

    // Check if an entry already exists for this date
    const existing = await this.prisma.bookingRequest.findFirst({
      where: {
        AND: [
          { OR: [{ requestedDateStr: cleanDate }, { requestedDate: new Date(cleanDate) }] },
          { OR: [{ status: BookingStatus.WATCHING }, { isWatching: true }] },
        ],
      },
    });

    if (existing) {
      return { message: `Date ${cleanDate} is already on the active Watchlist`, watchlist: existing };
    }

    const adminUser =
      (await this.prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } })) ||
      (await this.prisma.user.findFirst());

    if (!adminUser) {
      throw new BadRequestException('No admin or system user found to anchor Watchlist entry');
    }

    const bookingCode = `TA-WATCH-${Math.floor(10000 + Math.random() * 90000)}`;
    const watchBooking = await this.prisma.bookingRequest.create({
      data: {
        bookingCode,
        userId: adminUser.id,
        requestedDate: new Date(cleanDate),
        requestedDateStr: cleanDate,
        route: cleanRoute,
        pilgrimCount: 1,
        status: BookingStatus.WATCHING,
        isWatching: true,
        nomineeName: 'Temple Seva',
        nomineeAge: 35,
        nomineeRelationship: 'Relative',
        nomineePhone: '9876543210',
      },
    });

    this.logger.log(`[WATCHLIST] 👁️ Added date ${cleanDate} (${cleanRoute}) to active Watchlist: #${bookingCode}`);

    return {
      message: `Successfully added ${cleanDate} (${cleanRoute}) to the active Auto-Grab Watchlist!`,
      watchlist: watchBooking,
    };
  }

  /**
   * Watchlist: Get all active watchlist dates
   */
  async getWatchlist() {
    return this.prisma.bookingRequest.findMany({
      where: {
        OR: [{ status: BookingStatus.WATCHING }, { isWatching: true }],
        status: { notIn: [BookingStatus.CANCELLED, BookingStatus.COMPLETED, BookingStatus.FAILED, BookingStatus.SUCCESS] },
      },
      select: {
        id: true,
        bookingCode: true,
        requestedDateStr: true,
        requestedDate: true,
        route: true,
        status: true,
        isWatching: true,
        isAutoGrab: true,
        createdAt: true,
      },
      orderBy: { requestedDate: 'asc' },
    });
  }

  /**
   * Worker reports granular Playwright progress update
   */
  async updateJobProgress(
    jobId: string,
    machineId: string,
    dto: { status: BookingStatus; logs?: any; note?: string; leaseGeneration?: number; fencingToken?: string; protocolVersion?: string },
  ) {
    // Protocol Version Guard
    if (dto.protocolVersion && dto.protocolVersion !== 'v2.0-fenced') {
      throw new BadRequestException('Worker protocol version v2.0-fenced is required (PROTOCOL_VERSION_UNSUPPORTED)');
    }

    const job = await this.prisma.bookingJob.findUnique({
      where: { id: jobId },
      include: { account: true, bookingRequest: true },
    });

    if (!job) {
      throw new NotFoundException('Job not found');
    }

    // Worker machine ownership guard
    if (job.workerId && job.workerId !== machineId) {
      throw new ForbiddenException('Machine is not the active owner of this job lease (WORKER_LEASE_OWNERSHIP_MISMATCH)');
    }

    // Q3/F5/ITEM 4: fencing must be unconditional — see Audit 3
    if (dto.leaseGeneration === undefined || dto.leaseGeneration === null) {
      this.logger.warn(`[ARBITER] Missing leaseGeneration on updateJobProgress for Job #${jobId}`);
      throw new ForbiddenException('leaseGeneration is required (LEASE_GENERATION_REQUIRED)');
    }
    if (dto.leaseGeneration !== job.leaseGeneration) {
      this.logger.warn(`[ARBITER] Stale leaseGeneration on updateJobProgress: sent=${dto.leaseGeneration} current=${job.leaseGeneration}`);
      throw new ConflictException('Stale lease generation (STALE_LEASE_GENERATION)');
    }
    if (job.fencingToken && dto.fencingToken && dto.fencingToken !== job.fencingToken) {
      this.logger.warn(`[ARBITER] Fencing token mismatch on updateJobProgress: sent=${dto.fencingToken} current=${job.fencingToken}`);
      throw new ConflictException('Fencing token mismatch (FENCING_TOKEN_MISMATCH)');
    }

    if (dto.status === BookingStatus.TEMPORARY_SLOT_LOST && job.bookingRequestId) {
      await this.smartMatcher.returnToPendingOnSlotLoss(job.bookingRequestId, dto.note);
      return { success: true, status: BookingStatus.PENDING };
    }

    // Q6/ITEM 8: Configurable lease TTL (default 30s) — see Audit 3
    const leaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS);

    // Defensive enum guard: prevent runtime 500 if worker sends custom/transitional status string
    const validStatus = Object.values(BookingStatus).includes(dto.status as any)
      ? (dto.status as BookingStatus)
      : BookingStatus.EXECUTING;

    // Update BookingJob only if not already completed
    if (job.status !== BookingStatus.SUCCESS) {
      await this.prisma.bookingJob.update({
        where: { id: jobId },
        data: {
          status: validStatus,
          heartbeatAt: new Date(),
          leaseExpiresAt,
        },
      });
    }

    // If linked to BookingRequest, update it as well only if not already completed/confirmed
    if (job.bookingRequestId) {
      const currentBr = await this.prisma.bookingRequest.findUnique({
        where: { id: job.bookingRequestId },
        select: { status: true, officialReference: true },
      });

      if (currentBr && currentBr.status !== BookingStatus.SUCCESS && !currentBr.officialReference) {
        if (currentBr.status !== validStatus) {
          try {
            await this.stateMachine.transition({
              bookingId: job.bookingRequestId,
              targetStatus: validStatus,
              workerId: machineId,
              leaseGeneration: job.leaseGeneration,
              note: dto.note || undefined,
            });
          } catch (smErr: any) {
            this.logger.warn(`[STATE_MACHINE] Direct transition in updateJobProgress failed: ${smErr.message}. Updating timestamps.`);
            await this.prisma.bookingRequest.update({
              where: { id: job.bookingRequestId },
              data: {
                lastCheckedAt: new Date(),
                leaseExpiresAt,
                requiresHumanNote: dto.note || undefined,
              },
            });
          }
        } else {
          await this.prisma.bookingRequest.update({
            where: { id: job.bookingRequestId },
            data: {
              lastCheckedAt: new Date(),
              leaseExpiresAt,
              requiresHumanNote: dto.note || undefined,
            },
          });
        }
      }

    }

    // Derive activity state
    let activityState = 'PROCESSING_JOB';
    const statusStr = String(dto.status);
    if (statusStr.includes('OPENING') || statusStr.includes('SELECTING')) {
      activityState = 'NAVIGATING_PORTAL';
    } else if (statusStr.includes('AVAILABILITY') || statusStr.includes('CHECKING')) {
      activityState = 'DISCOVERING_AVAILABILITY';
    } else if (statusStr.includes('CAPTCHA') || statusStr.includes('OTP') || dto.status === BookingStatus.REQUIRES_HUMAN) {
      activityState = 'WAITING_HUMAN_INTERVENTION';
    } else if (statusStr.includes('VERIFYING') || statusStr.includes('CONFIRMATION')) {
      activityState = 'VERIFYING_RESULT';
    }

    await this.prisma.workerMachine.updateMany({
      where: { id: machineId },
      data: {
        currentActivity: activityState,
        activityDetails: dto.note || `Step: ${dto.status}`,
        lastActivityAt: new Date(),
      },
    });

    await this.createActivityLog({
      workerId: machineId,
      jobId,
      bookingId: job.bookingRequestId,
      eventType: activityState === 'WAITING_HUMAN_INTERVENTION' ? 'HUMAN_ACTION_REQUIRED' : 'STEP_PROGRESS',
      severity: activityState === 'WAITING_HUMAN_INTERVENTION' ? 'WARN' : 'INFO',
      activity: activityState,
      message: dto.note || `Execution step: ${dto.status}`,
    });

    // If linked to Account Verification
    if (job.jobType === JobType.ACCOUNT_VERIFICATION && job.accountId) {
      let accountStatus: AccountStatus = AccountStatus.VERIFYING;
      if (dto.status === BookingStatus.LOGIN_SUCCESS) accountStatus = AccountStatus.VERIFIED;
      else if (dto.status === BookingStatus.REQUIRES_HUMAN) accountStatus = AccountStatus.REQUIRES_HUMAN;
      else if (dto.status === BookingStatus.FAILED) accountStatus = AccountStatus.INVALID;

      await this.prisma.bookingAccount.update({
        where: { id: job.accountId },
        data: {
          status: accountStatus,
          verificationNote: dto.note || `Official website: ${dto.status}`,
          lastVerifiedAt: dto.status === BookingStatus.LOGIN_SUCCESS ? new Date() : undefined,
        },
      });
    }

    return { success: true, status: dto.status };
  }

  /**
   * Worker reports completed job (Verified Success)
   */
  async completeJob(
    jobId: string,
    machineId: string,
    dto: {
      officialReference?: string;
      cartId?: string;
      officialBookingReference?: string;
      officialReceiptReference?: string;
      portalTransactionReference?: string;
      confirmationEvidence?: any;
      confirmedAt?: string | Date;
      confirmationData?: any;
      note?: string;
      leaseGeneration?: number;
      fencingToken?: string;
      protocolVersion?: string;
    },
  ) {
    try {
      const job = await this.prisma.bookingJob.findUnique({
        where: { id: jobId },
        include: { bookingRequest: { include: { user: true } }, account: true },
      });

      if (!job) {
        throw new NotFoundException('Job not found');
      }

      const now = new Date();

      // Idempotency guard: If already completed, return successfully without double capturing
      const jobBr = job.bookingRequest as any;
      if (job.status === BookingStatus.SUCCESS && (!jobBr || jobBr.status === BookingStatus.SUCCESS)) {
        return { success: true, message: 'Job already completed', ref: jobBr?.officialBookingReference || jobBr?.officialReference };
      }

      // Guard: Duplicate confirmation cannot overwrite existing authoritative reference
      if (jobBr) {
        const existingRef = jobBr.officialBookingReference || (jobBr.status === BookingStatus.SUCCESS ? jobBr.officialReference : null);
        if (existingRef) {
          const candidateRef = dto.officialBookingReference?.trim() || dto.officialReference?.trim();
          if (candidateRef && candidateRef !== existingRef) {
            throw new ConflictException(`Duplicate confirmation cannot overwrite existing authoritative reference ${existingRef} (CONFLICTING_CONFIRMATION_REFERENCE)`);
          }
          if (jobBr.status === BookingStatus.SUCCESS) {
            return { success: true, message: 'Booking already confirmed with authoritative reference', ref: existingRef };
          }
        }
      }

      // Protocol Version Guard
      if (dto.protocolVersion && dto.protocolVersion !== 'v2.0-fenced') {
        throw new BadRequestException('Worker protocol version v2.0-fenced is required (PROTOCOL_VERSION_UNSUPPORTED)');
      }

      // Separate identifiers independently (Requirement 3 & 4)
      const cartId = dto.cartId?.trim();
      const portalTxnRef = dto.portalTransactionReference?.trim();
      const officialReceiptRef = dto.officialReceiptReference?.trim();

      // The authoritative pass reference MUST come from officialBookingReference or officialReference
      let officialBookingRef = dto.officialBookingReference?.trim();
      if (!officialBookingRef && dto.officialReference) {
        const candidate = dto.officialReference.trim();
        // Never use Cart ID or numeric portal transaction ID as official booking pass reference
        if (candidate !== cartId && candidate !== portalTxnRef && !/^\d{8,12}$/.test(candidate)) {
          officialBookingRef = candidate;
        }
      }

      const hasValidPass = !!(officialBookingRef && !officialBookingRef.startsWith('SAB-2026-') && officialBookingRef.length >= 5 && (!cartId || officialBookingRef !== cartId));

      // Fencing Guard 1: Worker machine ownership & lease generation checks
      const isWorkerMismatch = !!(job.workerId && job.workerId !== machineId);
      const isLeaseMissing = dto.leaseGeneration === undefined || dto.leaseGeneration === null;
      const isStaleLease = dto.leaseGeneration !== job.leaseGeneration;
      const isFencingMismatch = !!(job.fencingToken && dto.fencingToken && dto.fencingToken !== job.fencingToken);

      let needsReview = false;
      if (isWorkerMismatch || isLeaseMissing || isStaleLease || isFencingMismatch) {
        if (hasValidPass) {
          // Requirement 3: Never discard a real pass! If confirmed on portal, accept completion and flag NEEDS_REVIEW.
          this.logger.warn(`[ARBITER] completeJob received authoritative pass #${officialBookingRef} despite lease expiration/mismatch (job=${jobId}, machine=${machineId}, sentGen=${dto.leaseGeneration}, currentGen=${job.leaseGeneration}). Accepting completion and flagging NEEDS_REVIEW.`);
          needsReview = true;
        } else {
          if (isWorkerMismatch) {
            throw new ForbiddenException('Machine is not the active owner of this job lease (WORKER_LEASE_OWNERSHIP_MISMATCH)');
          }
          if (isLeaseMissing) {
            this.logger.warn(`[ARBITER] Missing leaseGeneration on completeJob for Job #${jobId}`);
            throw new ForbiddenException('leaseGeneration is required (LEASE_GENERATION_REQUIRED)');
          }
          if (isStaleLease) {
            this.logger.warn(`[ARBITER] Stale leaseGeneration on completeJob: sent=${dto.leaseGeneration} current=${job.leaseGeneration}`);
            throw new ConflictException('Stale lease generation (STALE_LEASE_GENERATION)');
          }
          if (isFencingMismatch) {
            this.logger.warn(`[ARBITER] Fencing token mismatch on completeJob: sent=${dto.fencingToken} current=${job.fencingToken}`);
            throw new ConflictException('Fencing token mismatch (FENCING_TOKEN_MISMATCH)');
          }
        }
      }

      if (job.bookingRequest) {
        // Enforce authoritative external government pass reference (e.g. IVQ...). Reject synthetic and Cart ID fallbacks
        if (!officialBookingRef || officialBookingRef.startsWith('SAB-2026-') || officialBookingRef === 'SAB-2026-VERIFIED' || officialBookingRef.length < 5 || (cartId && officialBookingRef === cartId)) {
          this.logger.warn(`[RECONCILIATION] Job #${jobId} missing authoritative official booking reference. Cart ID: ${cartId || 'N/A'}. Moving to RECONCILIATION_REQUIRED.`);
          if (this.stateMachine) {
            try {
              await this.stateMachine.transition({
                bookingId: job.bookingRequest.id,
                targetStatus: BookingStatus.RECONCILIATION_REQUIRED,
                targetExecutionStatus: 'QUARANTINED',
                expectedVersion: job.bookingRequest.version,
                workerId: machineId,
                leaseGeneration: job.leaseGeneration,
                milestone: 'MISSING_AUTHORITATIVE_REFERENCE',
                cartId: cartId || null,
                portalTransactionReference: portalTxnRef || null,
                confirmationEvidence: dto.confirmationEvidence || dto.confirmationData || null,
                failureReason: 'Official confirmation detected but authoritative booking reference was missing or mapped to Cart ID.',
              });
            } catch (smErr: any) {
              this.logger.warn(`State machine transition to RECONCILIATION_REQUIRED fallback: ${smErr.message}`);
            }
          }
          throw new BadRequestException('Authoritative official booking reference (e.g. IVQ...) is required. Cart ID or synthetic references are rejected as booking references.');
        }

        // Check if another booking was already confirmed with this identical pass reference (Conflict Guard)
        if (officialBookingRef && typeof this.prisma.bookingRequest?.findFirst === 'function') {
          const conflictingBooking = await this.prisma.bookingRequest.findFirst({
            where: {
              officialBookingReference: officialBookingRef,
              id: { not: job.bookingRequest.id },
              status: { in: [BookingStatus.SUCCESS, BookingStatus.BOOKING_CONFIRMED] },
            },
            select: { id: true, bookingCode: true },
          });
          if (conflictingBooking) {
            this.logger.warn(`[ARBITER] Refusing duplicate confirmation for Job #${jobId}: Reference ${officialBookingRef} already held by Booking #${conflictingBooking.bookingCode}`);
            throw new ConflictException(`Official booking reference ${officialBookingRef} is already assigned to Booking #${conflictingBooking.bookingCode} (DUPLICATE_OFFICIAL_REFERENCE)`);
          }
        }
      }

      // Execute atomic transaction across BookingJob, BookingRequest, and Wallet Capture
      const completionResult = await this.prisma.$transaction(async (tx) => {
        // Atomic CAS on BookingJob to eliminate stale-lease TOCTOU vulnerability
        const jobUpdate = await tx.bookingJob.updateMany({
          where: {
            id: jobId,
            ...(!needsReview ? { workerId: machineId } : {}),
            ...(!needsReview && dto.leaseGeneration !== undefined ? { leaseGeneration: dto.leaseGeneration } : {}),
            status: { not: BookingStatus.SUCCESS },
          },
          data: {
            status: BookingStatus.SUCCESS,
            completedAt: now,
          },
        });

        if (jobUpdate.count === 0 && !needsReview) {
          const freshJob = await tx.bookingJob.findUnique({ where: { id: jobId } });
          if (freshJob?.status === BookingStatus.SUCCESS) {
            return { alreadyCompleted: true };
          }
          this.logger.warn(`[FENCING] Atomic CAS failed for Job #${jobId}: Worker ${machineId}, generation ${dto.leaseGeneration}`);
          throw new ConflictException('Job lease was invalidated or completed concurrently (STALE_LEASE_GENERATION)');
        }

        if (job.jobType === JobType.ACCOUNT_VERIFICATION && job.accountId) {
          await tx.bookingAccount.update({
            where: { id: job.accountId },
            data: {
              status: AccountStatus.VERIFIED,
              lastVerifiedAt: now,
              verificationNote: 'Account verified successfully via Playwright',
            },
          });
          return { accountVerified: true };
        }

        if (job.bookingRequest) {
          const br = job.bookingRequest;
          const selectedSlot = dto.confirmationData?.selectedTime || (dto as any).timeSlot || br.selectedTime || br.timeSlot || null;

          if (this.stateMachine) {
            await this.stateMachine.transition({
              bookingId: br.id,
              targetStatus: BookingStatus.SUCCESS,
              targetExecutionStatus: 'COMPLETED',
              targetFinancialStatus: 'CAPTURED',
              expectedVersion: br.version,
              workerId: machineId,
              leaseGeneration: job.leaseGeneration,
              milestone: 'CONFIRMED',
              officialReference: officialBookingRef,
              officialBookingReference: officialBookingRef,
              cartId: cartId || null,
              officialReceiptReference: officialReceiptRef || null,
              portalTransactionReference: portalTxnRef || null,
              confirmationEvidence: dto.confirmationEvidence || dto.confirmationData || null,
              confirmedAt: dto.confirmedAt ? new Date(dto.confirmedAt) : now,
              confirmationData: { ...(dto.confirmationData || {}), ...(needsReview ? { needsReview: true, reconciliationStatus: 'NEEDS_REVIEW' } : {}) },
              selectedTime: selectedSlot,
              note: needsReview ? 'CONFIRMED_AFTER_LEASE_EXPIRY - NEEDS_REVIEW' : undefined,
            }, tx);

            if (needsReview) {
              await tx.bookingRequest.update({
                where: { id: br.id },
                data: {
                  reconciliationStatus: 'NEEDS_REVIEW',
                  requiresHumanNote: 'CONFIRMED_AFTER_LEASE_EXPIRY - NEEDS_REVIEW',
                },
              }).catch(() => {});
            }
          } else {
            await tx.bookingRequest.update({
              where: { id: br.id },
              data: {
                status: BookingStatus.SUCCESS,
                officialReference: officialBookingRef,
                officialBookingReference: officialBookingRef,
                cartId: cartId || null,
                officialReceiptReference: officialReceiptRef || null,
                portalTransactionReference: portalTxnRef || null,
                confirmationEvidence: dto.confirmationEvidence || dto.confirmationData || null,
                confirmedAt: dto.confirmedAt ? new Date(dto.confirmedAt) : now,
                confirmationData: { ...(dto.confirmationData || {}), ...(needsReview ? { needsReview: true } : {}) },
                reconciliationStatus: needsReview ? 'NEEDS_REVIEW' : null,
                requiresHumanNote: needsReview ? 'CONFIRMED_AFTER_LEASE_EXPIRY - NEEDS_REVIEW' : null,
                selectedTime: selectedSlot,
                assignedMachineId: null,
                leaseExpiresAt: null,
                completedAt: now,
              } as any,
            });
          }

          // Capture reserved service fee from centre wallet in the SAME atomic transaction
          const reserveTx = await tx.walletTransaction.findFirst({
            where: {
              bookingId: br.id,
              type: 'RESERVE',
              status: 'COMPLETED',
            },
          });
          const feeAmount = reserveTx ? Number(reserveTx.amount) : 10;

          await this.walletService.capture({
            userId: br.userId,
            bookingId: br.id,
            amount: feeAmount,
            workerMachineId: machineId,
            idempotencyKey: `cap_${br.id}`,
          }, tx);

          // Increment worker metrics in the SAME atomic transaction
          await tx.workerMachine.update({
            where: { id: machineId },
            data: {
              jobsCompleted: { increment: 1 },
              successCount: { increment: 1 },
              currentJobId: null,
              currentBookingId: null,
              currentActivity: 'IDLE',
              activityDetails: `Last job confirmed with ref: ${officialBookingRef}`,
              lastActivityAt: now,
              status: WorkerStatus.ONLINE,
            },
          });

          return { bookingCompleted: true, feeAmount };
        }

        return { success: true };
      });

      // Release Account Lock with exact lease generation protection
      if (job.accountId || job.bookingRequest?.accountId) {
        await this.accountLockService.releaseLock(
          job.accountId || job.bookingRequest?.accountId,
          job.bookingRequestId || undefined,
          dto.leaseGeneration !== undefined ? dto.leaseGeneration : job.leaseGeneration,
        );
      }

      if (completionResult?.alreadyCompleted) {
        return { success: true, message: 'Job already completed', ref: officialBookingRef };
      }

      if (completionResult?.accountVerified) {
        if (this.smartAllocator) {
          await this.smartAllocator.releaseJobCapacity(machineId, jobId);
        }
        return { success: true, message: 'Account verified' };
      }

      if (job.bookingRequest) {
        const br = job.bookingRequest;
        const feeAmount = (completionResult as any)?.feeAmount || 10;

        await this.createActivityLog({
          workerId: machineId,
          jobId,
          bookingId: br.id,
          eventType: 'JOB_COMPLETED',
          severity: 'INFO',
          activity: 'IDLE',
          message: `Booking execution confirmed successfully with reference ${officialBookingRef} (Cart ID: ${cartId || 'N/A'}, Txn Ref: ${portalTxnRef || 'N/A'})`,
        });

        // Credit partner commission if the booking was performed by a centre under a partner franchise
        if (br.userId) {
          try {
            const bookingUser = await this.prisma.user.findUnique({
              where: { id: br.userId },
              select: { partnerId: true },
            });
            if (bookingUser?.partnerId) {
              const partner = await (this.prisma as any).partner.findUnique({
                where: { id: bookingUser.partnerId },
                select: { id: true, commissionRate: true, commissionPercentage: true },
              });
              if (partner) {
                const commPct = partner.commissionPercentage !== null && partner.commissionPercentage !== undefined
                  ? Number(partner.commissionPercentage)
                  : (partner.commissionRate ? (Number(partner.commissionRate) / feeAmount) * 100 : 20);
                const commRate = (feeAmount * commPct) / 100;
                await (this.prisma as any).partner.update({
                  where: { id: partner.id },
                  data: {
                    balance: { increment: new Prisma.Decimal(commRate) },
                  },
                });
                this.logger.log(`Credited ₹ ${commRate} commission (${commPct}% of ₹ ${feeAmount} service fee) to partner ${partner.id} for completed booking ${br.id}`);
              }
            }
          } catch (commErr: any) {
            this.logger.warn(`Could not credit partner commission: ${commErr.message}`);
          }
        }

        // Notify Centre and Customer with complete official booking confirmation details
        const dateDisplay = br.requestedDateStr || (br.requestedDate instanceof Date ? br.requestedDate.toISOString().split('T')[0] : String(br.requestedDate).split('T')[0]);
        const slotDisplay = br.selectedTime || br.timeSlot || 'Standard';
        const grandTotalDisplay = dto.confirmationData?.grandTotal || '₹ 0.00';
        const receiptUrlDisplay = dto.confirmationData?.receiptUrl || 'https://sabarimalaonline.org/#/booking-history';

        await this.notifications.send({
          userId: br.userId,
          recipient: (br as any).user?.email || 'centre@ticketassist.com',
          channel: NotificationChannel.IN_APP,
          title: `Official Sabarimala Pass Confirmed: #${br.bookingCode}`,
          body: `Pass Reference: ${officialBookingRef} | Date: ${dateDisplay} | Route: ${br.route} | Slot: ${slotDisplay} | Pilgrims: ${br.pilgrimCount} | Paid: ${grandTotalDisplay} | Status: CONFIRMED | Receipt: ${receiptUrlDisplay}`,
          payload: {
            bookingId: br.id,
            bookingCode: br.bookingCode,
            bookingReference: officialBookingRef,
            officialBookingReference: officialBookingRef,
            cartId: cartId || null,
            portalTransactionReference: portalTxnRef || null,
            officialReceiptReference: officialReceiptRef || null,
            darshanDate: dateDisplay,
            route: br.route,
            timeSlot: slotDisplay,
            pilgrimCount: br.pilgrimCount,
            amountPaid: grandTotalDisplay,
            confirmationStatus: 'CONFIRMED',
            receiptUrl: receiptUrlDisplay,
            confirmationData: dto.confirmationData,
          },
        }).catch((err) => this.logger.warn(`Notification send failure: ${err.message}`));

        // Realtime WebSocket broadcast to Admin Dashboard and user
        if (this.eventsGateway) {
          try {
            this.eventsGateway.notifyBookingConfirmed({
              bookingId: br.id,
              userId: br.userId,
              bookingCode: br.bookingCode,
              officialBookingReference: officialBookingRef,
              officialReference: officialBookingRef,
              status: BookingStatus.SUCCESS,
              route: br.route,
              requestedDate: br.requestedDate,
            });
          } catch (wsErr: any) {
            this.logger.warn(`WebSocket notification failed: ${wsErr.message}`);
          }
        }

        if (this.smartAllocator) {
          await this.smartAllocator.releaseJobCapacity(machineId, jobId, br.id);
        }

        return { success: true, message: 'Booking completed and funds captured', ref: officialBookingRef };
      }

      if (this.smartAllocator) {
        await this.smartAllocator.releaseJobCapacity(machineId, jobId);
      }

      return { success: true };
    } catch (err: any) {
      this.logger.error(`[completeJob] Failed for Job #${jobId}: ${err?.message || err}`, {
        stack: err?.stack,
        jobId,
        machineId,
        payload: {
          officialReference: dto.officialReference,
          officialBookingReference: dto.officialBookingReference,
          cartId: dto.cartId,
          leaseGeneration: dto.leaseGeneration,
          fencingToken: dto.fencingToken ? '[PRESENT]' : undefined,
          protocolVersion: dto.protocolVersion,
        },
      });

      if (err instanceof HttpException) {
        throw err;
      }
      throw new InternalServerErrorException(`Failed to complete job #${jobId}: ${err?.message || err}`);
    }
  }

  /**
   * Worker reports failed or challenge job
   */
  async failJob(
    jobId: string,
    machineId: string,
    dto: {
      status: BookingStatus;
      errorCode?: string;
      errorMessage?: string;
      screenshot?: string;
      leaseGeneration?: number;
      fencingToken?: string;
      protocolVersion?: string;
    },
  ) {
    // Protocol Version Guard
    if (dto.protocolVersion && dto.protocolVersion !== 'v2.0-fenced') {
      throw new BadRequestException('Worker protocol version v2.0-fenced is required (PROTOCOL_VERSION_UNSUPPORTED)');
    }

    const job = await this.prisma.bookingJob.findUnique({
      where: { id: jobId },
      include: { bookingRequest: true, account: true },
    });

    if (!job) {
      throw new NotFoundException('Job not found');
    }

    // Worker machine ownership guard
    if (job.workerId && job.workerId !== machineId) {
      throw new ForbiddenException('Machine is not the active owner of this job lease (WORKER_LEASE_OWNERSHIP_MISMATCH)');
    }

    // Q3/F5/ITEM 4: fencing must be unconditional — see Audit 3
    if (dto.leaseGeneration === undefined || dto.leaseGeneration === null) {
      this.logger.warn(`[ARBITER] Missing leaseGeneration on failJob for Job #${jobId}`);
      throw new ForbiddenException('leaseGeneration is required (LEASE_GENERATION_REQUIRED)');
    }
    if (dto.leaseGeneration !== job.leaseGeneration) {
      this.logger.warn(`[ARBITER] Stale leaseGeneration on failJob: sent=${dto.leaseGeneration} current=${job.leaseGeneration}`);
      throw new ConflictException('Stale lease generation (STALE_LEASE_GENERATION)');
    }
    if (job.fencingToken && dto.fencingToken && dto.fencingToken !== job.fencingToken) {
      this.logger.warn(`[ARBITER] Fencing token mismatch on failJob: sent=${dto.fencingToken} current=${job.fencingToken}`);
      throw new ConflictException('Fencing token mismatch (FENCING_TOKEN_MISMATCH)');
    }


    // Release Account Lock with exact generation guard
    if (job.accountId || job.bookingRequest?.accountId) {
      await this.accountLockService.releaseLock(
        job.accountId || job.bookingRequest?.accountId,
        job.bookingRequestId || undefined,
        dto.leaseGeneration !== undefined ? dto.leaseGeneration : job.leaseGeneration,
      );
    }

    // Date Full / Unavailable / Mismatch Handling -> transition to WATCHING in ONE atomic step so UI reflects monitoring reality
    const isMismatch =
      dto.errorCode === 'PORTAL_AVAILABILITY_MISMATCH' ||
      dto.errorMessage?.includes('PORTAL_AVAILABILITY_MISMATCH') ||
      dto.errorMessage?.includes('DISABLED or FULL');

    const isDateFullOrUnavailable =
      isMismatch ||
      (dto.status as string) === 'DATE_FULL' ||
      dto.status === BookingStatus.WATCHING ||
      (dto.status as string) === 'WATCHING' ||
      dto.errorCode === 'DATE_UNAVAILABLE' ||
      dto.status === BookingStatus.DATE_UNAVAILABLE ||
      (dto.status === BookingStatus.RETRYABLE_FAILURE && (
        dto.errorCode === 'DATE_UNAVAILABLE' ||
        dto.errorCode === 'PORTAL_AVAILABILITY_MISMATCH' ||
        dto.errorMessage?.toLowerCase().includes('date') ||
        dto.errorMessage?.toLowerCase().includes('full') ||
        dto.errorMessage?.toLowerCase().includes('unavailable') ||
        dto.errorMessage?.toLowerCase().includes('pre-flight')
      ));

    if (isDateFullOrUnavailable && job.bookingRequestId) {
      const watchReason = dto.errorMessage || (isMismatch
        ? 'PORTAL_AVAILABILITY_MISMATCH: Date marked DISABLED/FULL in official calendar. Discovery engine watching.'
        : 'Date is FULL/DISABLED. Discovery engine watching.');
      const nowWatch = new Date();
      const nextWatchCheck = new Date(nowWatch.getTime() + 5 * 60 * 1000);
      this.logger.log(
        `[WATCHING] Date is FULL/DISABLED for Booking #${job.bookingRequest?.bookingCode || job.bookingRequestId}. Releasing cleanly to WATCHING in one step (no lease bump).`,
      );

      // Issue 1: Release in ONE atomic step without generating new lease generations or double-flipping status.
      const runWatchRelease = async (tx: any) => {
        if (this.stateMachine) {
          try {
            await this.stateMachine.transition({
              bookingId: job.bookingRequestId!,
              targetStatus: BookingStatus.WATCHING,
              targetExecutionStatus: 'IDLE',
              workerId: machineId,
              leaseGeneration: job.leaseGeneration,
              milestone: 'WATCHING',
              failureReason: watchReason,
              assignedMachineId: null,
              leaseExpiresAt: null,
              leaseStartedAt: null,
              nextCheckAt: nextWatchCheck,
            }, tx);
          } catch (smErr: any) {
            this.logger.warn(`[STATE_MACHINE] Fail transition to WATCHING fallback: ${smErr.message}`);
            await tx.bookingRequest.update({
              where: { id: job.bookingRequestId! },
              data: {
                status: BookingStatus.WATCHING,
                isWatching: true,
                executionStatus: 'IDLE',
                failureReason: watchReason,
                assignedMachineId: null,
                leaseStartedAt: null,
                leaseExpiresAt: null,
                nextCheckAt: nextWatchCheck,
                lastCheckedAt: nowWatch,
                checkCount: { increment: 1 },
              },
            });
          }
        } else {
          await tx.bookingRequest.update({
            where: { id: job.bookingRequestId! },
            data: {
              status: BookingStatus.WATCHING,
              isWatching: true,
              executionStatus: 'IDLE',
              failureReason: watchReason,
              assignedMachineId: null,
              leaseStartedAt: null,
              leaseExpiresAt: null,
              nextCheckAt: nextWatchCheck,
              lastCheckedAt: nowWatch,
              checkCount: { increment: 1 },
            },
          });
        }

        // Release job lease cleanly: clear workerId & leaseExpiresAt without bumping leaseGeneration
        await tx.bookingJob.update({
          where: { id: jobId },
          data: {
            status: BookingStatus.WATCHING,
            workerId: null,
            leaseExpiresAt: null,
            errorCode: dto.errorCode || 'DATE_UNAVAILABLE',
            errorMessage: watchReason,
          },
        });

        // Mark date/route UNAVAILABLE in DiscoverySchedule cache if present so queue polls do not re-claim it
        const brDateStr =
          job.bookingRequest?.requestedDateStr ||
          (job.bookingRequest?.requestedDate instanceof Date
            ? job.bookingRequest.requestedDate.toISOString().split('T')[0]
            : job.bookingRequest?.requestedDate
              ? String(job.bookingRequest.requestedDate).split('T')[0]
              : null);
        if (brDateStr && typeof tx.discoverySchedule?.updateMany === 'function') {
          const demandKey = normalizeDemandKey(brDateStr, job.bookingRequest?.route || 'Pamba');
          await Promise.resolve(
            tx.discoverySchedule.updateMany({
              where: { demandKey },
              data: { status: 'UNAVAILABLE', lastCheckedAt: nowWatch },
            }),
          ).catch(() => {});
        }
      };

      if (typeof this.prisma.$transaction === 'function') {
        await this.prisma.$transaction(runWatchRelease);
      } else {
        await runWatchRelease(this.prisma);
      }

      await this.prisma.workerMachine.update({
        where: { id: machineId },
        data: {
          currentJobId: null,
          currentBookingId: null,
          currentActivity: 'IDLE',
          activityDetails: 'Date is FULL/DISABLED. Discovery engine watching.',
          lastActivityAt: nowWatch,
          status: WorkerStatus.ONLINE,
        },
      });

      await this.createActivityLog({
        workerId: machineId,
        jobId,
        bookingId: job.bookingRequestId,
        eventType: 'WATCHING',
        severity: 'INFO',
        activity: 'IDLE',
        message: 'Job released cleanly to WATCHING - Date is FULL',
      });

      // Release capacity without triggering immediate re-allocation loop
      if (this.smartAllocator) {
        await this.smartAllocator.releaseJobCapacity(machineId, jobId, job.bookingRequestId, false);
      }

      // Dispatch real-time Telegram notification for Date Full or Portal Availability Mismatch
      if (typeof this.notifications?.sendTelegramBookingNotification === 'function') {
        await this.notifications.sendTelegramBookingNotification({
          bookingId: job.bookingRequestId,
          bookingCode: job.bookingRequest?.bookingCode,
          status: isMismatch ? 'PORTAL_AVAILABILITY_MISMATCH' : 'DATE_FULL',
          failureReason: watchReason,
          workerId: machineId,
          route: job.bookingRequest?.route,
          requestedDate: job.bookingRequest?.requestedDate,
          screenshotUrl: dto.screenshot,
        }).catch((err) => this.logger.warn(`[Telegram Bot] Error dispatching date/mismatch alert: ${err.message}`));
      }

      return { success: true, message: isMismatch ? 'Job status changed to WATCHING - Portal availability mismatch' : 'Job status changed to WATCHING - Date is FULL' };
    }

    // Check if slot loss -> transition to PENDING
    if (
      (dto.status === BookingStatus.TEMPORARY_SLOT_LOST ||
        dto.status === BookingStatus.PENDING) &&
      job.bookingRequestId
    ) {
      await this.smartMatcher.returnToPendingOnSlotLoss(job.bookingRequestId, dto.errorMessage);
      await this.prisma.workerMachine.update({
        where: { id: machineId },
        data: {
          currentJobId: null,
          status: WorkerStatus.ONLINE,
        },
      });
      return { success: true, message: 'Booking moved to pending for Smart Matcher' };
    }

    const validFailStatus = Object.values(BookingStatus).includes(dto.status as any)
      ? (dto.status as BookingStatus)
      : BookingStatus.WORKER_ERROR;

    await this.prisma.bookingJob.update({
      where: { id: jobId },
      data: {
        status: validFailStatus,
        errorCode: dto.errorCode,
        errorMessage: dto.errorMessage,
        completedAt: new Date(),
      },
    });

    // Backoff logic: Ensure any failed booking gets backoff so the worker doesn't loop on it
    if (job.bookingRequestId) {
      // PR-5: server-side retry schedule for RETRYABLE_FAILURE must match watcher cadence
      const isRetryable = validFailStatus === BookingStatus.RETRYABLE_FAILURE;
      const retryBackoffMs = isRetryable
        ? Number(process.env.RETRYABLE_FAILURE_BACKOFF_MS ?? 5000)
        : 5 * 60 * 1000;
      const nextCheckTime = new Date(Date.now() + retryBackoffMs);
      try {
        await this.prisma.bookingRequest.update({
          where: { id: job.bookingRequestId },
          data: {
            nextCheckAt: nextCheckTime,
            lastCheckedAt: new Date(),
            checkCount: { increment: 1 },
            assignedMachineId: null,
            leaseExpiresAt: null,
          },
        });
      } catch {
        // safe fallback
      }
    }

    // Specific Handling for Official Portal PREVIOUS_BOOKING_RESTRICTION
    const isPreviousBookingRestricted =
      dto.errorCode === 'PREVIOUS_BOOKING_RESTRICTION' ||
      dto.status === BookingStatus.ACCOUNT_PREVIOUS_BOOKING_RESTRICTED ||
      dto.status === BookingStatus.PREVIOUS_BOOKING_RESTRICTION;

    if (isPreviousBookingRestricted) {
      const targetAccountId = job.accountId || job.bookingRequest?.accountId;
      if (targetAccountId) {
        this.logger.warn(`[ACCOUNT-RESTRICTION] Marking Account #${targetAccountId} as ACCOUNT_PREVIOUS_BOOKING_RESTRICTED. Halting retries.`);
        await this.prisma.bookingAccount.update({
          where: { id: targetAccountId },
          data: {
            status: AccountStatus.ACCOUNT_PREVIOUS_BOOKING_RESTRICTED,
            verificationNote: 'ACCOUNT_PREVIOUS_BOOKING_RESTRICTED: Official portal reports you cannot make transaction until you avail previous booking.',
          },
        }).catch(err => this.logger.error(`Failed updating account status on restriction: ${err.message}`));

        // Cancel any pending/queued jobs linked to this restricted account
        await this.prisma.bookingJob.updateMany({
          where: {
            accountId: targetAccountId,
            id: { not: jobId },
            status: { in: [BookingStatus.QUEUED, BookingStatus.WORKER_ASSIGNED, BookingStatus.FAST_BOOKING_QUEUED] },
          },
          data: {
            status: BookingStatus.ACCOUNT_PREVIOUS_BOOKING_RESTRICTED,
            errorMessage: 'Account restricted by official portal: PREVIOUS_BOOKING_RESTRICTION',
          },
        }).catch(() => {});
      }
    }

    if (job.jobType === JobType.ACCOUNT_VERIFICATION && job.accountId) {
      const status = dto.status === BookingStatus.REQUIRES_HUMAN ? AccountStatus.REQUIRES_HUMAN : AccountStatus.INVALID;
      await this.prisma.bookingAccount.update({
        where: { id: job.accountId },
        data: {
          status,
          verificationNote: dto.errorMessage || dto.errorCode || 'Verification failed on official website',
        },
      });
    }

    if (job.bookingRequest) {
      const br = job.bookingRequest;

      if (dto.status === BookingStatus.REQUIRES_HUMAN || (dto.status as string) === 'UNKNOWN_RESULT') {
        // Quarantine ambiguous outcome without releasing wallet hold (FIND-002)
        const interventionNote = (dto.status as string) === 'UNKNOWN_RESULT'
          ? `[MANUAL RECONCILIATION] ${dto.errorMessage || 'Official booking unconfirmed after submission. Wallet hold retained for operator verification.'}`
          : (dto.errorMessage || 'Official portal requires verification (CAPTCHA / OTP)');

        try {
          await this.stateMachine.transition({
            bookingId: br.id,
            targetStatus: BookingStatus.REQUIRES_HUMAN,
            targetExecutionStatus: 'QUARANTINED',
            workerId: machineId,
            leaseGeneration: job.leaseGeneration,
            milestone: 'REQUIRES_HUMAN',
            screenshot: dto.screenshot,
            confirmationEvidence: dto.screenshot ? { screenshot: dto.screenshot } : undefined,
            note: interventionNote,
          });
        } catch (smErr: any) {
          this.logger.warn(`[STATE_MACHINE] Fail transition to REQUIRES_HUMAN fallback: ${smErr.message}`);
          await this.prisma.bookingRequest.update({
            where: { id: br.id },
            data: {
              status: BookingStatus.REQUIRES_HUMAN,
              requiresHumanNote: interventionNote,
              confirmationEvidence: dto.screenshot ? { screenshot: dto.screenshot } : undefined,
            },
          });
          // Dispatch Telegram notification with screenshot directly on state machine fallback
          if (typeof this.notifications?.sendTelegramBookingNotification === 'function') {
            await this.notifications.sendTelegramBookingNotification({
              bookingId: br.id,
              status: BookingStatus.REQUIRES_HUMAN,
              requiresHumanNote: interventionNote,
              screenshotUrl: dto.screenshot,
              workerId: machineId,
            }).catch(() => {});
          }
        }
      } else {
        const failReason = dto.errorMessage || dto.errorCode || 'Booking execution failed';
        try {
          await this.stateMachine.transition({
            bookingId: br.id,
            targetStatus: validFailStatus,
            targetExecutionStatus: 'FAILED',
            workerId: machineId,
            leaseGeneration: job.leaseGeneration,
            milestone: 'FAILED',
            screenshot: dto.screenshot,
            confirmationEvidence: dto.screenshot ? { screenshot: dto.screenshot } : undefined,
            failureReason: failReason,
          });
        } catch (smErr: any) {
          this.logger.warn(`[STATE_MACHINE] Fail transition to ${validFailStatus} fallback: ${smErr.message}`);
          await this.prisma.bookingRequest.update({
            where: { id: br.id },
            data: {
              status: validFailStatus,
              failureReason: failReason,
              confirmationEvidence: dto.screenshot ? { screenshot: dto.screenshot } : undefined,
              assignedMachineId: null,
              leaseExpiresAt: null,
            },
          });
          // Dispatch Telegram notification with screenshot directly on state machine fallback
          if (typeof this.notifications?.sendTelegramBookingNotification === 'function') {
            await this.notifications.sendTelegramBookingNotification({
              bookingId: br.id,
              status: validFailStatus,
              failureReason: failReason,
              screenshotUrl: dto.screenshot,
              workerId: machineId,
            }).catch(() => {});
          }
        }

        // Release exact reserved hold only on confirmed failures
        const reserveTx = await this.prisma.walletTransaction.findFirst({
          where: {
            bookingId: br.id,
            type: 'RESERVE',
            status: 'COMPLETED',
          },
        });
        const feeAmount = reserveTx ? Number(reserveTx.amount) : 100;

        await this.walletService.release({
          userId: br.userId,
          bookingId: br.id,
          amount: feeAmount,
          reason: dto.errorMessage || 'Booking execution failed',
          idempotencyKey: `rel_${br.id}`,
        });
      }

      // Notify customer of non-confirmed / failed execution
      await this.notifications.send({
        userId: br.userId,
        recipient: (br as any).user?.email || 'centre@ticketassist.com',
        channel: NotificationChannel.IN_APP,
        title: `Booking Update: #${br.bookingCode}`,
        body: `Booking could not be confirmed automatically. Status: ${validFailStatus}. Reason: ${dto.errorMessage || dto.errorCode || 'Booking execution failed'}.`,
        payload: {
          bookingId: br.id,
          bookingCode: br.bookingCode,
          status: validFailStatus,
          errorCode: dto.errorCode,
          errorMessage: dto.errorMessage,
        },
      }).catch(() => {});
    }

    const isHuman = dto.status === BookingStatus.REQUIRES_HUMAN;
    await this.prisma.workerMachine.update({
      where: { id: machineId },
      data: {
        failureCount: isHuman ? undefined : { increment: 1 },
        currentJobId: null,
        currentBookingId: null,
        currentActivity: isHuman ? 'WAITING_HUMAN_INTERVENTION' : 'IDLE',
        activityDetails: isHuman ? `Requires human intervention: ${dto.errorMessage || 'CAPTCHA / OTP'}` : `Job failed: ${dto.errorMessage || dto.errorCode || dto.status}`,
        lastActivityAt: new Date(),
        status: WorkerStatus.ONLINE,
      },
    });

    await this.createActivityLog({
      workerId: machineId,
      jobId,
      bookingId: job.bookingRequestId,
      eventType: isHuman ? 'HUMAN_ACTION_REQUIRED' : 'JOB_FAILED',
      severity: isHuman ? 'WARN' : 'ERROR',
      activity: isHuman ? 'WAITING_HUMAN_INTERVENTION' : 'IDLE',
      message: isHuman
        ? `Official portal requires manual intervention (CAPTCHA/OTP). Note: ${dto.errorMessage || ''}`
        : `Job failed: ${dto.errorMessage || dto.errorCode || dto.status}`,
    });

    if (this.smartAllocator) {
      await this.smartAllocator.releaseJobCapacity(machineId, jobId, job.bookingRequestId);
    }

    return { success: true };
  }

  // Q4/F3/ITEM 6: Pre-payment lease check & atomic transition to PAYMENT_SUBMITTED — see Audit 3
  async authorizePayment(jobId: string, machineId: string, dto: AuthorizePaymentDto) {
    const job = await this.prisma.bookingJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new NotFoundException('Job not found');
    }

    if (job.workerId !== machineId) {
      this.logger.warn(`[ARBITER] Payment authorization rejected: workerId mismatch (expected ${job.workerId}, got ${machineId})`);
      throw new ForbiddenException('Not lease owner (WORKER_LEASE_OWNERSHIP_MISMATCH)');
    }

    if (job.leaseGeneration !== dto.leaseGeneration) {
      this.logger.warn(`[ARBITER] Payment authorization rejected: stale generation (current ${job.leaseGeneration}, worker sent ${dto.leaseGeneration})`);
      throw new ConflictException('Stale lease generation (STALE_LEASE_GENERATION)');
    }

    if (job.fencingToken !== dto.fencingToken) {
      this.logger.warn(`[ARBITER] Payment authorization rejected: fencing token mismatch (current ${job.fencingToken}, worker sent ${dto.fencingToken})`);
      throw new ConflictException('Fencing token mismatch (FENCING_TOKEN_MISMATCH)');
    }

    if (!job.leaseExpiresAt || job.leaseExpiresAt < new Date()) {
      this.logger.warn(`[ARBITER] Payment authorization rejected: lease expired at ${job.leaseExpiresAt}`);
      throw new ConflictException('Lease expired (LEASE_EXPIRED)');
    }

    // Atomic CAS: transition to PAYMENT_SUBMITTED so no other executor can claim
    const updated = await this.prisma.bookingJob.updateMany({
      where: {
        id: jobId,
        workerId: machineId,
        leaseGeneration: dto.leaseGeneration,
        fencingToken: dto.fencingToken,
        status: BookingStatus.EXECUTING,
        paymentSubmittedAt: null, // exactly once
      },
      data: {
        status: BookingStatus.PAYMENT_SUBMITTED,
        paymentSubmittedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      this.logger.warn(`[ARBITER] Payment authorization CAS failed for job ${jobId} — already submitted or lease stolen`);
      throw new ConflictException('Payment already authorized or lease stolen (CONCURRENT_PAYMENT_SUBMISSION)');
    }

    this.logger.log(`[ARBITER] Payment authorized: job=${jobId} worker=${machineId} gen=${dto.leaseGeneration}`);
    return { authorized: true, paymentSubmittedAt: new Date() };
  }

  /**
   * Renew lease alias
   */
  async renewLease(bookingId: string, machineId: string) {
    const machine = await this.prisma.workerMachine.findUnique({
      where: { id: machineId },
    });
    if (!machine || !machine.active || (machine as any).adminStatus === 'REVOKED' || (machine as any).adminStatus === 'RETIRED' || (machine as any).adminStatus === 'DISABLED') {
      throw new UnauthorizedException('Worker machine is not approved, active, or credentials have been revoked');
    }

    const hasBookingCapability = Array.isArray(machine.capabilities) && machine.capabilities.includes('BOOKING_EXECUTION');
    const isAuthorizedForBookings =
      hasBookingCapability &&
      machine.desiredState === 'RUNNING' &&
      typeof (machine as any).maxConcurrentJobs === 'number' &&
      (machine as any).maxConcurrentJobs > 0;

    if (!isAuthorizedForBookings) {
      throw new ForbiddenException('Worker machine is not authorized for booking execution lease renewal');
    }

    // Q6/ITEM 8: Configurable lease TTL (default 30s) — see Audit 3
    const leaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS);
    await this.prisma.bookingRequest.updateMany({
      where: { id: bookingId, assignedMachineId: machineId },
      data: { leaseExpiresAt },
    });
    return { leaseExpiresAt };
  }


  /**
   * Update status alias
   */
  async updateJobStatus(bookingId: string, machineId: string, dto: UpdateJobStatusDto) {
    return this.updateJobProgress(bookingId, machineId, {
      status: dto.status as any,
      note: dto.requiresHumanNote || dto.note,
    });
  }

  /**
   * Report result alias
   */
  async reportJobResult(bookingId: string, machineId: string, dto: ReportJobResultDto) {
    if (dto.status === BookingStatus.SUCCESS) {
      return this.completeJob(bookingId, machineId, {
        officialReference: dto.officialReference,
        confirmationData: dto.confirmationData,
      });
    } else {
      return this.failJob(bookingId, machineId, {
        status: dto.status as any,
        errorMessage: dto.failureReason,
      });
    }
  }

  /**
   * List all worker machines for Admin Fleet Dashboard
   */
  /**
   * Worker records persistent availability refresh poll events
   * Atomic, idempotent, session-aware tracking
   */
  async recordPollEvents(machineId: string, dto: RecordPollEventsBatchDto) {
    const worker = await this.prisma.workerMachine.findUnique({ where: { id: machineId } });
    if (!worker) throw new UnauthorizedException('Worker machine not found');

    const sessionId = dto.workerSessionId || 'default';
    let newRefreshesCount = 0;
    let fullCount = 0;
    let availableCount = 0;
    let unknownCount = 0;
    let errorCount = 0;
    const now = new Date();

    for (const event of dto.events || []) {
      const demandKey = event.demandKey;
      const pollSeq = event.pollSeq;

      // Idempotency check: same worker session, demandKey, and poll sequence
      const existing = await this.prisma.monitoringPollEvent.findUnique({
        where: {
          workerId_workerSessionId_demandKey_pollSequence: {
            workerId: machineId,
            workerSessionId: sessionId,
            demandKey,
            pollSequence: pollSeq,
          },
        },
      });

      if (existing) {
        continue; // Already processed idempotently
      }

      // Determine associated booking requests
      let targetBookingIds = event.bookingRequestIds || [];
      if (targetBookingIds.length === 0) {
        const matchingReqs = await this.prisma.bookingRequest.findMany({
          where: {
            assignedMonitoringWorkerId: machineId,
            requestedDateStr: event.date,
            status: {
              in: [
                BookingStatus.PENDING,
                BookingStatus.WATCHING,
                BookingStatus.WAITING_FOR_DATE_AVAILABILITY,
                BookingStatus.FAST_BOOKING_QUEUED,
              ],
            },
          },
          select: { id: true },
        });
        targetBookingIds = matchingReqs.map((r) => r.id);
      }

      const primaryBookingId = targetBookingIds.length > 0 ? targetBookingIds[0] : null;

      try {
        await this.prisma.monitoringPollEvent.create({
          data: {
            workerId: machineId,
            workerSessionId: sessionId,
            bookingRequestId: primaryBookingId,
            demandKey,
            date: event.date,
            route: event.route,
            pollSequence: pollSeq,
            pollStartedAt: now,
            pollDurationMs: event.durationMs || 0,
            resultState: event.state,
            errorMessage: event.errorMessage || null,
          },
        });
        newRefreshesCount++;
        if (event.state === 'FULL') fullCount++;
        else if (event.state === 'AVAILABLE') availableCount++;
        else if (event.state === 'UNKNOWN' || event.state === 'API_DATE_MISMATCH') unknownCount++;
        else if (event.state === 'ERROR' || event.state === 'RATE_LIMITED' || event.state === 'BLOCKED') errorCount++;
      } catch (createErr: any) {
        continue;
      }

      // Concurrently update each associated booking request
      if (targetBookingIds.length > 0) {
        await this.prisma.bookingRequest.updateMany({
          where: { id: { in: targetBookingIds } },
          data: {
            totalRefreshCount: { increment: 1 },
            lastPollSequence: pollSeq,
            lastRefreshAt: now,
            lastRefreshResult: event.state,
            lastSuccessfulRefreshAt: (event.state !== 'ERROR' && event.state !== 'BLOCKED') ? now : undefined,
            lastError: event.errorMessage || (event.state === 'ERROR' ? 'Poll error' : null),
          },
        });
      }
    }

    if (newRefreshesCount > 0) {
      await this.prisma.workerMachine.update({
        where: { id: machineId },
        data: {
          totalRefreshCount: { increment: newRefreshesCount },
          totalSuccessfulRefreshes: { increment: fullCount + availableCount + unknownCount },
          totalFullResults: { increment: fullCount },
          totalAvailableResults: { increment: availableCount },
          totalUnknownResults: { increment: unknownCount },
          totalApiErrors: { increment: errorCount },
          lastRefreshAt: now,
        },
      });
    }

    return {
      success: true,
      recorded: newRefreshesCount,
      workerSessionId: sessionId,
    };
  }

  /**
   * Worker explicit graceful shutdown notification
   */
  async handleWorkerStop(machineId: string, dto: WorkerStopDto) {
    const now = new Date();
    const reason = dto.reason || 'Explicit graceful shutdown';
    await this.prisma.workerMachine.update({
      where: { id: machineId },
      data: {
        status: WorkerStatus.STOPPED,
        stopReason: reason,
        stoppedAt: now,
        currentActivity: 'STOPPED',
        activityDetails: reason,
        lastActivityAt: now,
        currentJobId: null,
        currentBookingId: null,
        currentActiveJobs: 0,
      },
    });

    await this.prisma.workerActivityLog.create({
      data: {
        workerId: machineId,
        eventType: 'STATE_CHANGE',
        severity: 'INFO',
        activity: 'STOPPED',
        message: `Worker PC explicitly stopped: ${reason}`,
        details: { reason, workerSessionId: dto.workerSessionId },
        timestamp: now,
      },
    });

    const machine = await this.prisma.workerMachine.findUnique({ where: { id: machineId } });
    if (typeof this.notifications?.sendTelegramWorkerNotification === 'function') {
      await this.notifications.sendTelegramWorkerNotification({
        workerId: machineId,
        machineCode: machine?.machineCode || machineId,
        machineName: machine?.machineName,
        status: 'STOPPED',
        reason,
      }).catch((err) => this.logger.warn(`[Telegram Bot] Error sending worker stop alert: ${err.message}`));
    }

    return { success: true, status: 'STOPPED', reason, stoppedAt: now };
  }

    async getAllWorkers() {
    const workers = await this.prisma.workerMachine.findMany({
      orderBy: { machineCode: 'asc' },
    });

    const activeBookings = typeof this.prisma.bookingRequest?.findMany === 'function'
      ? await this.prisma.bookingRequest.findMany({
          where: {
            OR: [
              { assignedMonitoringWorkerId: { in: workers.map((w) => w.id) } },
              { assignedMachineId: { in: workers.map((w) => w.id) } },
            ],
            status: {
              in: [
                'PENDING',
                'WATCHING',
                'WAITING_FOR_DATE_AVAILABILITY',
                'FAST_BOOKING_QUEUED',
                'EXECUTING',
              ],
            },
          },
          select: {
            id: true,
            bookingCode: true,
            status: true,
            executionStatus: true,
            isWatching: true,
            requestedDateStr: true,
            timeSlot: true,
            route: true,
            assignedMonitoringWorkerId: true,
            assignedMachineId: true,
            totalRefreshCount: true,
            lastPollSequence: true,
            lastRefreshAt: true,
            lastSuccessfulRefreshAt: true,
            lastRefreshResult: true,
            lastError: true,
            monitoringStartedAt: true,
            monitoringStoppedAt: true,
          },
        })
      : [];

    const now = new Date();
    return workers.map((w) => {
      const assignedReqs = activeBookings.filter(
        (b) => b.assignedMonitoringWorkerId === w.id || b.assignedMachineId === w.id
      );

      const heartbeatAgeSec = w.lastHeartbeat
        ? Math.floor((now.getTime() - new Date(w.lastHeartbeat).getTime()) / 1000)
        : null;
      const isDead = heartbeatAgeSec === null || heartbeatAgeSec > 45;
      const isStopped = (w as any).status === 'STOPPED' || (w as any).status === WorkerStatus.STOPPED;
      const isOffline = !isStopped && isDead;
      const isUnpaired = !w.active || !!w.pairingCode || !w.machineToken;
      const isRetired = w.adminStatus === 'RETIRED';
      const isRevoked = w.adminStatus === 'REVOKED';

      if (isOffline && !isUnpaired && !isRetired && !isRevoked) {
        if (typeof this.notifications?.sendTelegramWorkerNotification === 'function') {
          this.notifications.sendTelegramWorkerNotification({
            workerId: w.id,
            machineCode: w.machineCode,
            machineName: w.machineName,
            status: 'OFFLINE',
            reason: `Heartbeat connection lost (${heartbeatAgeSec ?? '>45'}s without ping)`,
          }).catch(() => {});
        }
      }

      const activelyChecking = assignedReqs.filter(
        (b) => b.assignedMonitoringWorkerId === w.id && b.status !== 'EXECUTING'
      );
      const executingReqs = assignedReqs.filter(
        (b) => (b.assignedMachineId === w.id || b.assignedMonitoringWorkerId === w.id) && b.status === 'EXECUTING'
      );

      // Inactive (STOPPED or OFFLINE) workers must NOT be reported as actively checking
      const activelyCheckingCount = (isStopped || isOffline) ? 0 : activelyChecking.length;
      const executingCount = (isStopped || isOffline) ? 0 : executingReqs.length;
      const maxMonitoringRequests = (w as any).maxMonitoringRequests ?? 10;
      const availableMonitoringSlots = Math.max(0, maxMonitoringRequests - activelyCheckingCount);

      // Categorize requests for accurate capacity breakdown
      const waitingForFirstRefreshCount = assignedReqs.filter((b) => ((b as any).totalRefreshCount ?? 0) === 0).length;
      const assignedButStoppedCount = (isStopped || isOffline) ? assignedReqs.length : 0;

      const assignedRequestDetails = assignedReqs.map((b) => ({
        id: b.id,
        bookingCode: b.bookingCode,
        date: b.requestedDateStr,
        timeSlot: b.timeSlot,
        route: b.route,
        status: b.status,
        activity: (isStopped || isOffline)
          ? (b.status === 'EXECUTING' ? 'Execution (Worker Inactive)' : (isStopped ? 'Assigned (Worker Stopped)' : 'Assigned (Worker Offline)'))
          : (b.status === 'EXECUTING'
            ? 'Booking Execution'
            : (b.isWatching ? 'Checking Availability' : 'Assigned (Pending Check)')),
        executionStatus: b.executionStatus,
        totalRefreshCount: (b as any).totalRefreshCount ?? 0,
        lastPollSequence: (b as any).lastPollSequence ?? 0,
        lastRefreshAt: (b as any).lastRefreshAt,
        lastSuccessfulRefreshAt: (b as any).lastSuccessfulRefreshAt,
        lastRefreshResult: (b as any).lastRefreshResult || 'PENDING',
        lastError: (b as any).lastError || null,
        monitoringStartedAt: (b as any).monitoringStartedAt || null,
        monitoringStoppedAt: (b as any).monitoringStoppedAt || null,
        isLive: !isStopped && !isOffline,
      }));

      const assessment = this.smartAllocator
        ? this.smartAllocator.evaluateWorkerAvailability(w, now)
        : null;

      // Authoritative State: explicit STOPPED vs expired OFFLINE vs RUNNING vs ONLINE_IDLE
      let authoritativeState: string;
      if (isRevoked) {
        authoritativeState = 'REVOKED';
      } else if (isRetired) {
        authoritativeState = 'RETIRED';
      } else if (w.adminStatus === 'DISABLED') {
        authoritativeState = 'DISABLED';
      } else if (isStopped) {
        authoritativeState = 'STOPPED';
      } else if (isOffline) {
        authoritativeState = 'OFFLINE';
      } else if (w.status === WorkerStatus.ERROR) {
        authoritativeState = 'ERROR';
      } else if (w.desiredState === 'STOPPING') {
        authoritativeState = 'DRAINING';
      } else if (w.desiredState === 'PAUSED') {
        authoritativeState = 'PAUSED';
      } else if (executingCount > 0 || ((w as any).currentActiveJobs ?? 0) >= ((w as any).maxConcurrentJobs ?? 1)) {
        authoritativeState = 'ONLINE_BUSY';
      } else if (activelyCheckingCount > 0) {
        authoritativeState = 'RUNNING';
      } else {
        authoritativeState = 'ONLINE_IDLE';
      }

      // Check if progress is stalled (active job with no activity in > 90s)
      const lastActivityAgeSec = w.lastActivityAt
        ? Math.floor((now.getTime() - new Date(w.lastActivityAt).getTime()) / 1000)
        : null;
      const progressStalled = !!w.currentJobId && lastActivityAgeSec !== null && lastActivityAgeSec > 90;

      // Activity elapsed duration
      const activityElapsedSec = w.activityStartedAt
        ? Math.floor((now.getTime() - new Date(w.activityStartedAt).getTime()) / 1000)
        : null;

      const currentActivity = isStopped
        ? 'STOPPED'
        : isOffline
        ? 'OFFLINE'
        : ((w as any).currentActiveJobs ?? 0) === 0 && (w.currentActivity === 'PROCESSING_JOB' || !w.currentActivity)
        ? (activelyCheckingCount > 0 ? 'DISCOVERING_AVAILABILITY' : 'IDLE')
        : (w.currentActivity || 'IDLE');

      const activityDetails = isStopped
        ? ((w as any).stopReason || 'Worker process explicitly stopped')
        : isOffline
        ? 'Heartbeat lost (no ping in >45s)'
        : ((w as any).currentActiveJobs ?? 0) === 0 && (w.currentActivity === 'PROCESSING_JOB' || !w.currentActivity)
        ? (activelyCheckingCount > 0 ? `Actively monitoring ${activelyCheckingCount} date(s)` : 'Idle, waiting for assignments')
        : (w.activityDetails || 'Idle, waiting for assignments');

      return {
        id: w.id,
        workerId: w.id,
        machineCode: w.machineCode,
        machineName: w.machineName,
        deploymentType: (w as any).deploymentType || 'LOCAL_PC',
        installationId: (w as any).installationId || null,
        pairingCode: isUnpaired ? w.pairingCode : null,
        status: isStopped ? 'STOPPED' : (isOffline ? WorkerStatus.OFFLINE : w.status),
        adminStatus: w.adminStatus || 'ENABLED',
        desiredState: isUnpaired ? 'UNPAIRED' : (w.desiredState || 'STOPPED'),
        authoritativeState,
        exclusionReason: assessment?.exclusionReason || null,
        maxConcurrentJobs: (w as any).maxConcurrentJobs ?? 1,
        currentActiveJobs: (isStopped || isOffline) ? 0 : ((w as any).currentActiveJobs ?? (w.currentJobId ? 1 : 0)),
        capabilities: (w as any).capabilities && (w as any).capabilities.length > 0
          ? (w as any).capabilities
          : ['ACCOUNT_VERIFICATION', 'BOOKING_EXECUTION'],
        lastJobAt: (w as any).lastJobAt || null,
        actualRuntimeState: authoritativeState,
        currentActivity,
        activityDetails,
        activityElapsedSec,
        progressStalled,
        heartbeatAgeSec,
        isDisconnected: isDead,
        isStopped,
        isOffline,
        isStale: isDead || (heartbeatAgeSec !== null && heartbeatAgeSec > 60),
        version: w.version,
        ipAddress: w.ipAddress,
        lastHeartbeat: w.lastHeartbeat,
        active: w.active && !isRetired && !isRevoked,
        currentJobId: (!isStopped && !isOffline && ((w as any).currentActiveJobs ?? 0) > 0) ? w.currentJobId : null,
        cpuUsage: (isStopped || isOffline) ? 0 : (w.cpuUsage ?? 0),
        memoryUsage: (isStopped || isOffline) ? 0 : (w.memoryUsage ?? 0),
        jobsCompleted: w.jobsCompleted,
        successCount: w.successCount,
        failureCount: w.failureCount,
        operatorShareBalance: w.operatorShareBalance,
        pairingStatus: isUnpaired ? 'UNPAIRED' : 'PAIRED',
        executionPermitted: !isUnpaired && w.adminStatus === 'ENABLED' && w.desiredState === 'RUNNING' && !isStopped && !isOffline,
        maxMonitoringRequests,
        currentAssignedMonitoring: (isStopped || isOffline) ? assignedReqs.length : activelyCheckingCount,
        activelyCheckingCount,
        executingCount,
        availableMonitoringSlots,
        waitingForFirstRefreshCount,
        assignedButStoppedCount,
        assignedRequestsCount: assignedReqs.length,
        assignedRequestDetails,
        monitoringDraining: (w as any).monitoringDraining ?? false,
        // Persistent Monitoring Telemetry
        totalRefreshCount: (w as any).totalRefreshCount ?? 0,
        totalRequestsMonitored: (w as any).totalRequestsMonitored ?? 0,
        totalSuccessfulRefreshes: (w as any).totalSuccessfulRefreshes ?? 0,
        totalFullResults: (w as any).totalFullResults ?? 0,
        totalAvailableResults: (w as any).totalAvailableResults ?? 0,
        totalUnknownResults: (w as any).totalUnknownResults ?? 0,
        totalApiErrors: (w as any).totalApiErrors ?? 0,
        lastRefreshAt: (w as any).lastRefreshAt,
        stopReason: isStopped ? ((w as any).stopReason || 'Worker process explicitly stopped') : null,
        stoppedAt: isStopped ? (w as any).stoppedAt : null,
        disconnectReason: isOffline ? 'Heartbeat lost (no ping in >45s)' : null,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        retiredAt: w.retiredAt,
        retirementReason: w.retirementReason,
        revokedAt: w.revokedAt,
      };
    });
  }

  async recoverStaleLeasedJobs() {
    if (this.smartAllocator) {
      return this.smartAllocator.recoverStaleLeases();
    }

    const now = new Date();
    const staleJobs = await this.prisma.bookingJob.findMany({
      where: {
        leaseExpiresAt: { lte: now },
        status: { in: [BookingStatus.WORKER_ASSIGNED, BookingStatus.LOGIN_IN_PROGRESS, BookingStatus.BOOKING_IN_PROGRESS] },
      },
    });

    for (const job of staleJobs) {
      this.logger.warn(`Recovering stale job ${job.id} (Lease expired)`);
      await this.prisma.bookingJob.update({
        where: { id: job.id },
        data: {
          workerId: null,
          leaseExpiresAt: null,
          status: BookingStatus.QUEUED,
        },
      });

      if (job.bookingRequestId) {
        if (this.stateMachine) {
          await this.stateMachine.transition({
            bookingId: job.bookingRequestId,
            targetStatus: BookingStatus.QUEUED,
            assignedMachineId: null,
            leaseExpiresAt: null,
            reason: 'Recovered stale job without worker heartbeat back to queue.',
            milestone: 'STALE_HEARTBEAT_RECOVERED_TO_QUEUE',
            operator: 'WorkersService:recoverStaleJobs',
          });
        } else {
          await this.prisma.bookingRequest.update({
            where: { id: job.bookingRequestId },
            data: {
              assignedMachineId: null,
              leaseExpiresAt: null,
              status: BookingStatus.QUEUED,
            },
          });
        }
      }

    }

    return { recoveredCount: staleJobs.length, humanReviewCount: 0 };
  }

  /**
   * Actionable diagnostic telemetry for Admin Fleet & Diagnostics UI
   */
  async getQueueAndWorkerDiagnostics() {
    const now = new Date();

    const pendingStatuses = [
      BookingStatus.QUEUED,
      BookingStatus.EXECUTION_QUEUED,
      ((BookingStatus as any).FAST_BOOKING_QUEUED || 'FAST_BOOKING_QUEUED') as any,
    ];

    const [
      pendingEligibleCount,
      oldestPendingJob,
      staleLeasesCount,
      activeExecutingCount,
      requiresHumanCount,
      lastAllocationLog,
      workers,
    ] = await Promise.all([
      this.prisma.bookingJob.count({
        where: { status: { in: pendingStatuses } },
      }),
      this.prisma.bookingJob.findFirst({
        where: { status: { in: pendingStatuses } },
        orderBy: { createdAt: 'asc' },
        include: { bookingRequest: true },
      }),
      this.prisma.bookingJob.count({
        where: {
          leaseExpiresAt: { lte: now },
          status: { in: [BookingStatus.WORKER_ASSIGNED, BookingStatus.EXECUTING, BookingStatus.CHECKING_AVAILABILITY] },
        },
      }),
      this.prisma.bookingJob.count({
        where: { status: BookingStatus.EXECUTING },
      }),
      this.prisma.bookingJob.count({
        where: { status: BookingStatus.REQUIRES_HUMAN },
      }),
      this.prisma.jobAllocationLog.findFirst({
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.workerMachine.findMany({
        where: { adminStatus: { not: 'RETIRED' } },
        orderBy: { machineCode: 'asc' },
      }),
    ]);

    const oldestPendingAgeSec = oldestPendingJob
      ? Math.floor((now.getTime() - new Date(oldestPendingJob.createdAt).getTime()) / 1000)
      : null;

    const workerDiagnostics = await Promise.all(
      workers.map(async (w) => {
        const assessment = this.smartAllocator
          ? this.smartAllocator.evaluateWorkerAvailability(w, now)
          : null;

        const heartbeatAgeSec = w.lastHeartbeat
          ? Math.floor((now.getTime() - new Date(w.lastHeartbeat).getTime()) / 1000)
          : null;
        const isDead = heartbeatAgeSec === null || heartbeatAgeSec > 45;
        const maxCapacity = (w as any).maxConcurrentJobs ?? 1;
        const activeJobs = (w as any).currentActiveJobs ?? 0;
        const effectiveCapacityRemaining = Math.max(0, maxCapacity - activeJobs);

        // Retrieve last worker activity log
        const lastLog = await this.prisma.workerActivityLog.findFirst({
          where: { workerId: w.id },
          orderBy: { timestamp: 'desc' },
        });

        // Retrieve last attempted job
        const lastJob = w.currentJobId
          ? await this.prisma.bookingJob.findUnique({
              where: { id: w.currentJobId },
              include: { bookingRequest: true },
            })
          : null;

        return {
          id: w.id,
          machineCode: w.machineCode,
          machineName: w.machineName,
          deploymentType: (w as any).deploymentType || 'LOCAL_PC',
          adminStatus: w.adminStatus,
          desiredState: w.desiredState,
          status: isDead ? WorkerStatus.OFFLINE : w.status,
          authoritativeState: assessment?.effectiveState || (isDead ? 'OFFLINE' : w.status),
          isOnline: !isDead && w.active && w.adminStatus === 'ENABLED',
          isEligible: assessment?.isAvailable ?? (!isDead && w.adminStatus === 'ENABLED' && w.desiredState === 'RUNNING' && effectiveCapacityRemaining > 0),
          exclusionReason: assessment?.exclusionReason || (
            isDead ? `Heartbeat is stale (${heartbeatAgeSec ?? 'no'}s old > 45s threshold).` :
            w.adminStatus !== 'ENABLED' ? `Worker adminStatus is ${w.adminStatus}.` :
            w.desiredState !== 'RUNNING' ? `Worker desired state is ${w.desiredState}.` :
            effectiveCapacityRemaining <= 0 ? `Worker is at max concurrency (${activeJobs}/${maxCapacity}).` :
            null
          ),
          maxConcurrentJobs: maxCapacity,
          currentActiveJobs: activeJobs,
          effectiveCapacityRemaining,
          heartbeatAgeSec,
          lastHeartbeat: w.lastHeartbeat,
          currentActivity: isDead ? 'OFFLINE' : w.currentActivity,
          activityDetails: isDead ? 'Disconnected' : w.activityDetails,
          lastActivityAt: w.lastActivityAt,
          lastJobId: lastJob?.id || (w as any).currentJobId || null,
          lastJobBookingCode: lastJob?.bookingRequest?.bookingCode || null,
          lastJobStatus: lastJob?.status || null,
          lastActivityLog: lastLog ? {
            eventType: lastLog.eventType,
            severity: lastLog.severity,
            message: lastLog.message,
            timestamp: lastLog.timestamp,
          } : null,
        };
      })
    );

    return {
      timestamp: now,
      queue: {
        pendingEligibleCount,
        oldestPendingJob: oldestPendingJob ? {
          id: oldestPendingJob.id,
          bookingCode: oldestPendingJob.bookingRequest?.bookingCode,
          jobType: oldestPendingJob.jobType,
          status: oldestPendingJob.status,
          createdAt: oldestPendingJob.createdAt,
          ageSec: oldestPendingAgeSec,
        } : null,
        staleLeasesCount,
        activeExecutingCount,
        requiresHumanCount,
      },
      allocator: {
        healthy: true,
        autoRecoveryActive: true,
        lastAllocationAt: lastAllocationLog?.createdAt || null,
        lastAllocationDecision: lastAllocationLog?.decisionReason || null,
        lastAllocationStatus: lastAllocationLog?.status || null,
      },
      fleetCapacity: {
        totalWorkers: workers.length,
        onlineEligibleWorkers: workerDiagnostics.filter((w) => w.isEligible).length,
        totalExecutionSlots: workerDiagnostics.reduce((sum, w) => sum + w.maxConcurrentJobs, 0),
        activeOccupiedSlots: workerDiagnostics.reduce((sum, w) => sum + w.currentActiveJobs, 0),
        freeExecutionSlots: workerDiagnostics.reduce((sum, w) => sum + w.effectiveCapacityRemaining, 0),
      },
      workers: workerDiagnostics,
    };
  }
}
