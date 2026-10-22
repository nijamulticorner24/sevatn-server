import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  ConflictException,
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
} from './dto/worker.dto';
import { WorkerStatus, BookingStatus, NotificationChannel, JobType, AccountStatus, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { AccountLockService } from '../availability/account-lock.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { hashMachineToken } from '../common/security/token-hash';
import { EventsGateway } from '../events/events.gateway';
import { SmartAllocatorService } from './smart-allocator.service';

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

    for (const w of workers) {
      const isDead = !w.lastHeartbeat || now.getTime() - new Date(w.lastHeartbeat).getTime() > 45000;
      const isOnline = !isDead && w.active && w.adminStatus !== 'REVOKED';

      if (isOnline) onlineCount++;
      else offlineCount++;

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

    const updated = await this.prisma.workerMachine.update({
      where: { id: machineId },
      data: {
        status: dto.status as any,
        desiredState: nextDesiredState,
        version: dto.version,
        deploymentType: dto.deploymentType || undefined,
        installationId: dto.installationId || undefined,
        maxConcurrentJobs: dto.maxConcurrentJobs ? dto.maxConcurrentJobs : undefined,
        currentJobId: effectiveJobId,
        currentBookingId: dto.currentBookingId || null,
        currentActivity,
        activityDetails,
        lastActivityAt: now,
        activityStartedAt: existingMachine?.currentActivity !== currentActivity ? now : (existingMachine?.activityStartedAt || now),
        cpuUsage: dto.cpuUsage,
        memoryUsage: dto.memoryUsage,
        lastHeartbeat: now,
      },
    });

    if (this.smartAllocator) {
      await this.smartAllocator.reconcileWorkerCapacity(machineId);
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
      serverTime: now,
    };
  }

  /**
   * Worker claims next eligible job (ACCOUNT_VERIFICATION or BOOKING_EXECUTION)
   * Enforces atomic single-owner claim via Prisma transaction with conditional updates.
   * Strictly enforces Super Admin start/stop state and administrative authorization.
   */
  async claimJob(machineId: string) {
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
    const leaseExpiry = new Date(now.getTime() + 180 * 1000); // 3 min lease

    // 1. First priority: Check if a job was already reserved specifically for this worker by the central SmartAllocator
    const preAllocatedJob = await this.prisma.bookingJob.findFirst({
      where: {
        workerId: machineId,
        status: { in: [BookingStatus.WORKER_ASSIGNED, BookingStatus.EXECUTING] },
      },
      include: {
        account: true,
        bookingRequest: {
          include: { pilgrims: true, account: true },
        },
      },
      orderBy: { startedAt: 'desc' },
    });

    if (preAllocatedJob) {
      // Worker is retrieving its assigned job. Ensure lease is fresh and state transitions to EXECUTING.
      await this.prisma.bookingJob.update({
        where: { id: preAllocatedJob.id },
        data: {
          status: BookingStatus.EXECUTING,
          startedAt: preAllocatedJob.startedAt || now,
          heartbeatAt: now,
          leaseExpiresAt: leaseExpiry,
        },
      });

      if (preAllocatedJob.bookingRequestId) {
        await this.prisma.bookingRequest.update({
          where: { id: preAllocatedJob.bookingRequestId },
          data: {
            assignedMachineId: machineId,
            status: BookingStatus.EXECUTING,
            leaseExpiresAt: leaseExpiry,
          },
        });
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
          },
        };
      }

      if (preAllocatedJob.jobType === JobType.BOOKING_EXECUTION && preAllocatedJob.bookingRequest) {
        const br = preAllocatedJob.bookingRequest;
        const account = preAllocatedJob.account || br.account;
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
            account: account ? {
              id: account.id,
              username: account.username,
              encryptedPassword: account.encryptedPassword,
              encryptionIv: account.encryptionIv,
              encryptionTag: account.encryptionTag,
            } : null,
            leaseExpiresAt: leaseExpiry,
          },
        };
      }
    }

    // 2. Capacity enforcement: If no pre-allocated job exists for this worker, reject claim from queue if at max capacity
    const maxCapacity = (machine as any).maxConcurrentJobs ?? 1;
    let currentActive = (machine as any).currentActiveJobs ?? 0;
    if (currentActive >= maxCapacity && this.smartAllocator) {
      currentActive = await this.smartAllocator.reconcileWorkerCapacity(machineId);
    }
    if (currentActive >= maxCapacity) {
      return {
        hasJob: false,
        message: `Worker is at max concurrency capacity (${currentActive}/${maxCapacity})`,
      };
    }

    return await this.prisma.$transaction(async (tx) => {
      // 1. First priority: Account Verification Jobs
      const verificationJob = await tx.bookingJob.findFirst({
        where: {
          jobType: JobType.ACCOUNT_VERIFICATION,
          status: BookingStatus.QUEUED,
        },
        include: {
          account: true,
        },
        orderBy: { createdAt: 'asc' },
      });

      if (verificationJob && verificationJob.account) {
        // Atomic conditional claim: only transitions if still QUEUED
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
          },
        });

        if (claimResult.count === 1) {
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
            },
          };
        }
      }

      // 2. Second priority: Booking Execution Jobs
      const eligibleStatuses = [
        BookingStatus.QUEUED,
        BookingStatus.EXECUTION_QUEUED,
        ((BookingStatus as any).FAST_BOOKING_QUEUED || 'FAST_BOOKING_QUEUED') as any,
      ];

      const bookingJob = await tx.bookingJob.findFirst({
        where: {
          jobType: JobType.BOOKING_EXECUTION,
          OR: [
            { status: { in: eligibleStatuses } },
            {
              status: BookingStatus.WATCHING,
              leaseExpiresAt: { lte: now },
            },
            {
              status: BookingStatus.CHECKING_AVAILABILITY,
              leaseExpiresAt: { lte: now },
            },
          ],
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
      });

      if (bookingJob && bookingJob.bookingRequest) {
        const br = bookingJob.bookingRequest;
        const account = bookingJob.account || br.account;

        // Same Account Lock check
        if (account?.id) {
          const lockAcquired = await this.accountLockService.acquireLock(account.id, br.id, machineId);
          if (!lockAcquired) {
            this.logger.warn(`[CLAIM] Booking #${br.bookingCode} account is currently locked by another worker.`);
            return { hasJob: false, message: 'Matching booking account currently locked' };
          }
        }

        // Atomic conditional update ensuring exact single ownership
        const claimResult = await tx.bookingJob.updateMany({
          where: {
            id: bookingJob.id,
            status: bookingJob.status,
            OR: [
              { workerId: null },
              { leaseExpiresAt: { lte: now } },
              { workerId: machineId },
            ],
          },
          data: {
            workerId: machineId,
            startedAt: now,
            heartbeatAt: now,
            leaseExpiresAt: leaseExpiry,
            status: BookingStatus.EXECUTING,
            attempt: { increment: 1 },
          },
        });

        if (claimResult.count === 0) {
          // Lost race to another worker. Release acquired lock and exit safely.
          if (account?.id) {
            await this.accountLockService.releaseLock(account.id, br.id);
          }
          return { hasJob: false, message: 'Job was claimed concurrently by another worker' };
        }

        // Successfully and exclusively claimed! Update booking request and attempt log.
        await tx.bookingRequest.update({
          where: { id: br.id },
          data: {
            assignedMachineId: machineId,
            leaseStartedAt: now,
            leaseExpiresAt: leaseExpiry,
            status: BookingStatus.EXECUTING,
          },
        });

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

        const dateOnlyStr = br.requestedDateStr || (br.requestedDate instanceof Date ? br.requestedDate.toISOString().split('T')[0] : String(br.requestedDate).split('T')[0]);

        await tx.workerMachine.update({
          where: { id: machineId },
          data: {
            status: WorkerStatus.BUSY,
            currentJobId: bookingJob.id,
            currentBookingId: br.id,
            currentActiveJobs: { increment: 1 },
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
          message: `Claimed booking execution job #${br.bookingCode} for ${dateOnlyStr}`,
        });

        return {
          hasJob: true,
          jobType: JobType.BOOKING_EXECUTION,
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
          },
        };
      }

      return { hasJob: false, message: 'No pending jobs in queue' };
    });
  }

  /**
   * Worker reports granular Playwright progress update
   */
  async updateJobProgress(jobId: string, machineId: string, dto: { status: BookingStatus; logs?: any; note?: string }) {
    const job = await this.prisma.bookingJob.findUnique({
      where: { id: jobId },
      include: { account: true, bookingRequest: true },
    });

    if (!job) {
      throw new NotFoundException('Job not found');
    }

    if (dto.status === BookingStatus.TEMPORARY_SLOT_LOST && job.bookingRequestId) {
      await this.smartMatcher.returnToPendingOnSlotLoss(job.bookingRequestId, dto.note);
      return { success: true, status: BookingStatus.PENDING };
    }

    const leaseExpiresAt = new Date(Date.now() + 180 * 1000);

    // Update BookingJob only if not already completed
    if (job.status !== BookingStatus.SUCCESS) {
      await this.prisma.bookingJob.update({
        where: { id: jobId },
        data: {
          status: dto.status,
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
        await this.prisma.bookingRequest.update({
          where: { id: job.bookingRequestId },
          data: {
            status: dto.status,
            lastCheckedAt: new Date(),
            leaseExpiresAt,
            requiresHumanNote: dto.note || undefined,
          },
        });
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
  async completeJob(jobId: string, machineId: string, dto: { officialReference?: string; confirmationData?: any; note?: string }) {
    const job = await this.prisma.bookingJob.findUnique({
      where: { id: jobId },
      include: { bookingRequest: { include: { user: true } }, account: true },
    });

    if (!job) {
      throw new NotFoundException('Job not found');
    }

    const now = new Date();

    // Idempotency guard: If already completed, return successfully without double capturing
    if (job.status === BookingStatus.SUCCESS) {
      return { success: true, message: 'Job already completed', ref: job.bookingRequest?.officialReference };
    }

    // Ownership guard: Reject stale workers whose lease has transferred to another worker
    if (job.workerId && job.workerId !== machineId && job.leaseExpiresAt && job.leaseExpiresAt > now) {
      throw new ForbiddenException('Machine is not the active owner of this job lease');
    }

    // Release Account Lock
    if (job.accountId || job.bookingRequest?.accountId) {
      await this.accountLockService.releaseLock(job.accountId || job.bookingRequest?.accountId, job.bookingRequestId || undefined);
    }

    // Finalize BookingJob
    await this.prisma.bookingJob.update({
      where: { id: jobId },
      data: {
        status: BookingStatus.SUCCESS,
        completedAt: now,
      },
    });

    if (job.jobType === JobType.ACCOUNT_VERIFICATION && job.accountId) {
      await this.prisma.bookingAccount.update({
        where: { id: job.accountId },
        data: {
          status: AccountStatus.VERIFIED,
          lastVerifiedAt: now,
          verificationNote: 'Account verified successfully via Playwright',
        },
      });
      if (this.smartAllocator) {
        await this.smartAllocator.releaseJobCapacity(machineId, jobId);
      }
      return { success: true, message: 'Account verified' };
    }

    if (job.bookingRequest) {
      const br = job.bookingRequest;
      const ref = dto.officialReference?.trim();

      // Enforce authoritative external government reference (FIND-004)
      if (!ref || ref.startsWith('SAB-2026-') || ref === 'SAB-2026-VERIFIED' || ref.length < 5) {
        throw new BadRequestException('Authoritative official booking reference is required. Synthetic or mock references are rejected.');
      }

      await this.prisma.bookingRequest.update({
        where: { id: br.id },
        data: {
          status: BookingStatus.SUCCESS,
          officialReference: ref,
          confirmationData: dto.confirmationData || {},
          assignedMachineId: null,
          leaseExpiresAt: null,
          completedAt: now,
        },
      });

      // Capture reserved service fee from centre wallet
      const reserveTx = await this.prisma.walletTransaction.findFirst({
        where: {
          bookingId: br.id,
          type: 'RESERVE',
          status: 'COMPLETED',
        },
      });
      const feeAmount = reserveTx ? Number(reserveTx.amount) : 100;

      await this.walletService.capture({
        userId: br.userId,
        bookingId: br.id,
        amount: feeAmount,
        workerMachineId: machineId,
        idempotencyKey: `cap_${br.id}`,
      });

      // Increment worker metrics
      await this.prisma.workerMachine.update({
        where: { id: machineId },
        data: {
          jobsCompleted: { increment: 1 },
          successCount: { increment: 1 },
          currentJobId: null,
          currentBookingId: null,
          currentActivity: 'IDLE',
          activityDetails: `Last job confirmed with ref: ${ref}`,
          lastActivityAt: now,
          status: WorkerStatus.ONLINE,
        },
      });

      await this.createActivityLog({
        workerId: machineId,
        jobId,
        bookingId: br.id,
        eventType: 'JOB_COMPLETED',
        severity: 'INFO',
        activity: 'IDLE',
        message: `Booking execution confirmed successfully with reference ${ref}`,
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
              this.logger.log(`Credited ₹${commRate} commission (${commPct}% of ₹${feeAmount} service fee) to partner ${partner.id} for completed booking ${br.id}`);
            }
          }
        } catch (commErr: any) {
          this.logger.warn(`Could not credit partner commission: ${commErr.message}`);
        }
      }

      // Notify Centre
      await this.notifications.send({
        userId: br.userId,
        recipient: br.user.email,
        channel: NotificationChannel.IN_APP,
        title: `Official Sabarimala Pass Confirmed: #${br.bookingCode}`,
        body: `Pass Reference: ${ref}. Pilgrims: ${br.pilgrimCount}.`,
        payload: { bookingId: br.id, ref },
      });

      if (this.smartAllocator) {
        await this.smartAllocator.releaseJobCapacity(machineId, jobId, br.id);
      }

      return { success: true, message: 'Booking completed and funds captured' };
    }

    if (this.smartAllocator) {
      await this.smartAllocator.releaseJobCapacity(machineId, jobId);
    }

    return { success: true };
  }

  /**
   * Worker reports failed or challenge job
   */
  async failJob(jobId: string, machineId: string, dto: { status: BookingStatus; errorCode?: string; errorMessage?: string }) {
    const job = await this.prisma.bookingJob.findUnique({
      where: { id: jobId },
      include: { bookingRequest: true, account: true },
    });

    if (!job) {
      throw new NotFoundException('Job not found');
    }

    // Release Account Lock
    if (job.accountId || job.bookingRequest?.accountId) {
      await this.accountLockService.releaseLock(job.accountId || job.bookingRequest?.accountId, job.bookingRequestId || undefined);
    }

    // Check if slot loss or date unavailable -> transition to PENDING
    if (
      (dto.status === BookingStatus.TEMPORARY_SLOT_LOST ||
        dto.status === BookingStatus.DATE_UNAVAILABLE ||
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

    await this.prisma.bookingJob.update({
      where: { id: jobId },
      data: {
        status: dto.status,
        errorCode: dto.errorCode,
        errorMessage: dto.errorMessage,
        completedAt: new Date(),
      },
    });

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
        await this.prisma.bookingRequest.update({
          where: { id: br.id },
          data: {
            status: BookingStatus.REQUIRES_HUMAN,
            requiresHumanNote: (dto.status as string) === 'UNKNOWN_RESULT'
              ? `[MANUAL RECONCILIATION] ${dto.errorMessage || 'Official booking unconfirmed after submission. Wallet hold retained for operator verification.'}`
              : (dto.errorMessage || 'Official portal requires verification (CAPTCHA / OTP)'),
          },
        });
      } else {
        await this.prisma.bookingRequest.update({
          where: { id: br.id },
          data: {
            status: dto.status,
            failureReason: dto.errorMessage || dto.errorCode || 'Booking execution failed',
            assignedMachineId: null,
            leaseExpiresAt: null,
          },
        });

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

  /**
   * Renew lease alias
   */
  async renewLease(bookingId: string, machineId: string) {
    const leaseExpiresAt = new Date(Date.now() + 180 * 1000);
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
  async getAllWorkers() {
    const workers = await this.prisma.workerMachine.findMany({
      orderBy: { machineCode: 'asc' },
    });

    const now = new Date();
    return workers.map((w) => {
      const assessment = this.smartAllocator
        ? this.smartAllocator.evaluateWorkerAvailability(w, now)
        : null;

      const heartbeatAgeSec = w.lastHeartbeat
        ? Math.floor((now.getTime() - new Date(w.lastHeartbeat).getTime()) / 1000)
        : null;
      const isDead = heartbeatAgeSec === null || heartbeatAgeSec > 45;
      const isUnpaired = !w.active || !!w.pairingCode || !w.machineToken;
      const isRetired = w.adminStatus === 'RETIRED';
      const isRevoked = w.adminStatus === 'REVOKED';

      // Authoritative State derived from smart allocator or backend signals
      const authoritativeState = assessment?.effectiveState || (
        isRevoked ? 'REVOKED' :
        isRetired ? 'RETIRED' :
        w.adminStatus === 'DISABLED' ? 'DISABLED' :
        isDead ? 'OFFLINE' :
        w.desiredState === 'STOPPING' ? 'DRAINING' :
        w.desiredState === 'PAUSED' ? 'PAUSED' :
        w.status === WorkerStatus.ERROR ? 'ERROR' :
        ((w as any).currentActiveJobs ?? 0) >= ((w as any).maxConcurrentJobs ?? 1) ? 'ONLINE_BUSY' :
        'ONLINE_IDLE'
      );

      // Check if progress is stalled (active job with no activity in > 90s)
      const lastActivityAgeSec = w.lastActivityAt
        ? Math.floor((now.getTime() - new Date(w.lastActivityAt).getTime()) / 1000)
        : null;
      const progressStalled = !!w.currentJobId && lastActivityAgeSec !== null && lastActivityAgeSec > 90;

      // Activity elapsed duration
      const activityElapsedSec = w.activityStartedAt
        ? Math.floor((now.getTime() - new Date(w.activityStartedAt).getTime()) / 1000)
        : null;

      return {
        id: w.id,
        workerId: w.id,
        machineCode: w.machineCode,
        machineName: w.machineName,
        deploymentType: (w as any).deploymentType || 'LOCAL_PC',
        installationId: (w as any).installationId || null,
        pairingCode: isUnpaired ? w.pairingCode : null,
        status: isDead && w.active && !isRetired ? WorkerStatus.OFFLINE : w.status,
        adminStatus: w.adminStatus || 'ENABLED',
        desiredState: isUnpaired ? 'UNPAIRED' : (w.desiredState || 'STOPPED'),
        authoritativeState,
        exclusionReason: assessment?.exclusionReason || null,
        maxConcurrentJobs: (w as any).maxConcurrentJobs ?? 1,
        currentActiveJobs: (w as any).currentActiveJobs ?? (w.currentJobId ? 1 : 0),
        capabilities: (w as any).capabilities && (w as any).capabilities.length > 0
          ? (w as any).capabilities
          : ['ACCOUNT_VERIFICATION', 'BOOKING_EXECUTION'],
        lastJobAt: (w as any).lastJobAt || null,
        actualRuntimeState: authoritativeState,
        currentActivity: isDead ? 'OFFLINE' : (w.currentActivity || 'IDLE'),
        activityDetails: isDead ? 'Worker node is disconnected' : (w.activityDetails || 'Idle, waiting for assignments'),
        activityElapsedSec,
        progressStalled,
        heartbeatAgeSec,
        isDisconnected: isDead,
        isStale: isDead || (heartbeatAgeSec !== null && heartbeatAgeSec > 60),
        version: w.version,
        ipAddress: w.ipAddress,
        lastHeartbeat: w.lastHeartbeat,
        active: w.active && !isRetired && !isRevoked,
        currentJobId: w.currentJobId,
        cpuUsage: w.cpuUsage ?? 0,
        memoryUsage: w.memoryUsage ?? 0,
        jobsCompleted: w.jobsCompleted,
        successCount: w.successCount,
        failureCount: w.failureCount,
        operatorShareBalance: w.operatorShareBalance,
        pairingStatus: isUnpaired ? 'UNPAIRED' : 'PAIRED',
        executionPermitted: !isUnpaired && w.adminStatus === 'ENABLED' && w.desiredState === 'RUNNING',
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
        retiredAt: w.retiredAt,
        retirementReason: w.retirementReason,
        revokedAt: w.revokedAt,
      };
    });
  }

  /**
   * Auto-recover stale leased jobs where worker disconnected
   */
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
