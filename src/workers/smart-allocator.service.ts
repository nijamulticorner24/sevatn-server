import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AccountLockService } from '../availability/account-lock.service';
import { EventsGateway } from '../events/events.gateway';
import { BookingStateMachineService } from '../bookings/booking-state-machine.service';
import { BookingsService } from '../bookings/bookings.service';
import { WalletService } from '../wallet/wallet.service';
import { WorkerStatus, BookingStatus, JobType, Prisma } from '@prisma/client';
import { validateNominee } from '../common/nominee-validator';
import {
  ACTIVE_RUNNING_JOB_STATUSES,
  TERMINAL_OR_EXCLUDED_BOOKING_STATUSES,
  TERMINAL_BOOKING_CLOSURE_STATUSES,
  evaluateJobActiveCapacity,
  extractAuthoritativeReference,
} from '../common/booking-status.constants';
import { normalizeDemandKey } from '../common/utils/demand-key';

export interface WorkerAvailabilityAssessment {
  workerId: string;
  machineCode: string;
  machineName: string;
  deploymentType: string;
  isAvailable: boolean;
  effectiveState:
    | 'ONLINE_IDLE'
    | 'ONLINE_BUSY'
    | 'OFFLINE'
    | 'PAUSED'
    | 'DRAINING'
    | 'DISABLED'
    | 'REVOKED'
    | 'RETIRED'
    | 'ERROR';
  maxConcurrentJobs: number;
  currentActiveJobs: number;
  capacityRemaining: number;
  cpuUsage: number;
  memoryUsage: number;
  capabilities: string[];
  lastHeartbeat: Date | null;
  heartbeatAgeSec: number | null;
  exclusionReason: string | null;
}

export interface AllocationResult {
  allocated: boolean;
  jobId?: string;
  workerId?: string;
  machineCode?: string;
  decisionReason: string;
  candidateCount?: number;
  evaluatedWorkers?: any[];
}

@Injectable()
export class SmartAllocatorService {
  private readonly logger = new Logger(SmartAllocatorService.name);
  private isSweepRunning = false;
  private readonly STALE_HEARTBEAT_THRESHOLD_SEC = 45;
  private readonly DEFAULT_LEASE_DURATION_SEC = 180; // 3 minutes

  constructor(
    private prisma: PrismaService,
    private accountLockService: AccountLockService,
    @Optional() private eventsGateway?: EventsGateway,
    @Optional() private stateMachine?: BookingStateMachineService,
    @Optional() @Inject(forwardRef(() => BookingsService)) private bookingsService?: BookingsService,
    @Optional() @Inject(forwardRef(() => WalletService)) private walletService?: WalletService,
  ) {}

  /**
   * Periodic background task running every 30 seconds to:
   * 1. Safely recover stale/expired worker leases back to queue.
   * 2. Sweep queued pending jobs and assign to eligible idle workers.
   */
  @Interval(10000)
  async handlePeriodicAllocationAndRecovery() {
    try {
      await this.recoverStaleLeases();
      await this.runAllocationSweep();
      await this.recoverStaleMonitoringLeases();
      await this.runMonitoringAllocationSweep();
    } catch (err: any) {
      this.logger.warn(`Periodic allocator background sweep notice: ${err?.message || err}`);
    }
  }

  /**
   * Authoritatively evaluates a worker machine's real availability state.
   * Derives state from authoritative backend signals, not self-reported status alone.
   */
  evaluateWorkerAvailability(
    worker: any,
    now: Date = new Date(),
  ): WorkerAvailabilityAssessment {
    const heartbeatAgeSec = worker.lastHeartbeat
      ? Math.floor((now.getTime() - new Date(worker.lastHeartbeat).getTime()) / 1000)
      : null;

    const isDead = heartbeatAgeSec === null || heartbeatAgeSec > this.STALE_HEARTBEAT_THRESHOLD_SEC;
    const maxCapacity = worker.maxConcurrentJobs ?? 1;
    const activeJobs = worker.currentActiveJobs ?? 0;
    const capacityRemaining = Math.max(0, maxCapacity - activeJobs);
    const capabilities = worker.capabilities && worker.capabilities.length > 0
      ? worker.capabilities
      : ['ACCOUNT_VERIFICATION', 'BOOKING_EXECUTION', 'AVAILABILITY_DISCOVERY'];

    // 1. Check administrative enablement and revocation
    if (worker.adminStatus === 'REVOKED') {
      return {
        workerId: worker.id,
        machineCode: worker.machineCode,
        machineName: worker.machineName,
        deploymentType: worker.deploymentType || 'LOCAL_PC',
        isAvailable: false,
        effectiveState: 'REVOKED',
        maxConcurrentJobs: maxCapacity,
        currentActiveJobs: activeJobs,
        capacityRemaining: 0,
        cpuUsage: worker.cpuUsage ?? 0,
        memoryUsage: worker.memoryUsage ?? 0,
        capabilities,
        lastHeartbeat: worker.lastHeartbeat,
        heartbeatAgeSec,
        exclusionReason: 'Worker credentials have been permanently revoked by administrator.',
      };
    }

    if (worker.adminStatus === 'RETIRED') {
      return {
        workerId: worker.id,
        machineCode: worker.machineCode,
        machineName: worker.machineName,
        deploymentType: worker.deploymentType || 'LOCAL_PC',
        isAvailable: false,
        effectiveState: 'RETIRED',
        maxConcurrentJobs: maxCapacity,
        currentActiveJobs: activeJobs,
        capacityRemaining: 0,
        cpuUsage: worker.cpuUsage ?? 0,
        memoryUsage: worker.memoryUsage ?? 0,
        capabilities,
        lastHeartbeat: worker.lastHeartbeat,
        heartbeatAgeSec,
        exclusionReason: 'Worker machine has been retired from active fleet.',
      };
    }

    if (!worker.active || !worker.machineToken) {
      return {
        workerId: worker.id,
        machineCode: worker.machineCode,
        machineName: worker.machineName,
        deploymentType: worker.deploymentType || 'LOCAL_PC',
        isAvailable: false,
        effectiveState: 'DISABLED',
        maxConcurrentJobs: maxCapacity,
        currentActiveJobs: activeJobs,
        capacityRemaining: 0,
        cpuUsage: worker.cpuUsage ?? 0,
        memoryUsage: worker.memoryUsage ?? 0,
        capabilities,
        lastHeartbeat: worker.lastHeartbeat,
        heartbeatAgeSec,
        exclusionReason: 'Worker is unapproved or pairing has not been completed.',
      };
    }

    if (worker.adminStatus === 'DISABLED') {
      return {
        workerId: worker.id,
        machineCode: worker.machineCode,
        machineName: worker.machineName,
        deploymentType: worker.deploymentType || 'LOCAL_PC',
        isAvailable: false,
        effectiveState: 'DISABLED',
        maxConcurrentJobs: maxCapacity,
        currentActiveJobs: activeJobs,
        capacityRemaining: 0,
        cpuUsage: worker.cpuUsage ?? 0,
        memoryUsage: worker.memoryUsage ?? 0,
        capabilities,
        lastHeartbeat: worker.lastHeartbeat,
        heartbeatAgeSec,
        exclusionReason: 'Worker is administratively disabled.',
      };
    }

    // 2. Check desired execution state
    if (worker.desiredState === 'PAUSED') {
      return {
        workerId: worker.id,
        machineCode: worker.machineCode,
        machineName: worker.machineName,
        deploymentType: worker.deploymentType || 'LOCAL_PC',
        isAvailable: false,
        effectiveState: 'PAUSED',
        maxConcurrentJobs: maxCapacity,
        currentActiveJobs: activeJobs,
        capacityRemaining: 0,
        cpuUsage: worker.cpuUsage ?? 0,
        memoryUsage: worker.memoryUsage ?? 0,
        capabilities,
        lastHeartbeat: worker.lastHeartbeat,
        heartbeatAgeSec,
        exclusionReason: 'Worker execution is paused by administrator.',
      };
    }

    if (worker.desiredState === 'STOPPING') {
      return {
        workerId: worker.id,
        machineCode: worker.machineCode,
        machineName: worker.machineName,
        deploymentType: worker.deploymentType || 'LOCAL_PC',
        isAvailable: false,
        effectiveState: 'DRAINING',
        maxConcurrentJobs: maxCapacity,
        currentActiveJobs: activeJobs,
        capacityRemaining: 0,
        cpuUsage: worker.cpuUsage ?? 0,
        memoryUsage: worker.memoryUsage ?? 0,
        capabilities,
        lastHeartbeat: worker.lastHeartbeat,
        heartbeatAgeSec,
        exclusionReason: 'Worker is draining existing jobs; no new jobs accepted.',
      };
    }

    if (worker.desiredState === 'STOPPED') {
      return {
        workerId: worker.id,
        machineCode: worker.machineCode,
        machineName: worker.machineName,
        deploymentType: worker.deploymentType || 'LOCAL_PC',
        isAvailable: false,
        effectiveState: 'DISABLED',
        maxConcurrentJobs: maxCapacity,
        currentActiveJobs: activeJobs,
        capacityRemaining: 0,
        cpuUsage: worker.cpuUsage ?? 0,
        memoryUsage: worker.memoryUsage ?? 0,
        capabilities,
        lastHeartbeat: worker.lastHeartbeat,
        heartbeatAgeSec,
        exclusionReason: 'Worker execution state is STOPPED.',
      };
    }

    if (worker.desiredState === 'MONITOR_ONLY' || maxCapacity <= 0) {
      return {
        workerId: worker.id,
        machineCode: worker.machineCode,
        machineName: worker.machineName,
        deploymentType: worker.deploymentType || 'LOCAL_PC',
        isAvailable: false,
        effectiveState: 'ONLINE_IDLE',
        maxConcurrentJobs: maxCapacity,
        currentActiveJobs: activeJobs,
        capacityRemaining: 0,
        cpuUsage: worker.cpuUsage ?? 0,
        memoryUsage: worker.memoryUsage ?? 0,
        capabilities,
        lastHeartbeat: worker.lastHeartbeat,
        heartbeatAgeSec,
        exclusionReason: 'Worker is in MONITOR_ONLY mode (booking execution disabled).',
      };
    }

    // 3. Check health and heartbeat liveness
    if (isDead) {
      return {
        workerId: worker.id,
        machineCode: worker.machineCode,
        machineName: worker.machineName,
        deploymentType: worker.deploymentType || 'LOCAL_PC',
        isAvailable: false,
        effectiveState: 'OFFLINE',
        maxConcurrentJobs: maxCapacity,
        currentActiveJobs: activeJobs,
        capacityRemaining: 0,
        cpuUsage: worker.cpuUsage ?? 0,
        memoryUsage: worker.memoryUsage ?? 0,
        capabilities,
        lastHeartbeat: worker.lastHeartbeat,
        heartbeatAgeSec,
        exclusionReason: `Worker heartbeat is stale (${heartbeatAgeSec ?? 'never'}s old > ${this.STALE_HEARTBEAT_THRESHOLD_SEC}s threshold).`,
      };
    }

    if (worker.status === WorkerStatus.ERROR) {
      return {
        workerId: worker.id,
        machineCode: worker.machineCode,
        machineName: worker.machineName,
        deploymentType: worker.deploymentType || 'LOCAL_PC',
        isAvailable: false,
        effectiveState: 'ERROR',
        maxConcurrentJobs: maxCapacity,
        currentActiveJobs: activeJobs,
        capacityRemaining: 0,
        cpuUsage: worker.cpuUsage ?? 0,
        memoryUsage: worker.memoryUsage ?? 0,
        capabilities,
        lastHeartbeat: worker.lastHeartbeat,
        heartbeatAgeSec,
        exclusionReason: 'Worker reported an unrecoverable runtime error.',
      };
    }

    // 4. Check capacity limits
    if (capacityRemaining <= 0) {
      return {
        workerId: worker.id,
        machineCode: worker.machineCode,
        machineName: worker.machineName,
        deploymentType: worker.deploymentType || 'LOCAL_PC',
        isAvailable: false,
        effectiveState: 'ONLINE_BUSY',
        maxConcurrentJobs: maxCapacity,
        currentActiveJobs: activeJobs,
        capacityRemaining: 0,
        cpuUsage: worker.cpuUsage ?? 0,
        memoryUsage: worker.memoryUsage ?? 0,
        capabilities,
        lastHeartbeat: worker.lastHeartbeat,
        heartbeatAgeSec,
        exclusionReason: `Worker is at maximum concurrency limit (${activeJobs}/${maxCapacity} active jobs).`,
      };
    }

    // 5. Worker is online, healthy, and has capacity!
    const effectiveState = activeJobs === 0 ? 'ONLINE_IDLE' : 'ONLINE_BUSY';
    return {
      workerId: worker.id,
      machineCode: worker.machineCode,
      machineName: worker.machineName,
      deploymentType: worker.deploymentType || 'LOCAL_PC',
      isAvailable: true,
      effectiveState,
      maxConcurrentJobs: maxCapacity,
      currentActiveJobs: activeJobs,
      capacityRemaining,
      cpuUsage: worker.cpuUsage ?? 0,
      memoryUsage: worker.memoryUsage ?? 0,
      capabilities,
      lastHeartbeat: worker.lastHeartbeat,
      heartbeatAgeSec,
      exclusionReason: null,
    };
  }

  /**
   * Implements Least-Loaded First Selection Policy with deterministic tie-breaking.
   * Ranks eligible candidate workers by load ratio, resource utilization, and recency.
   */
  selectBestWorker(
    candidates: any[],
    jobType: string,
  ): {
    selected: any | null;
    reason: string;
    candidateEvaluations: any[];
  } {
    const evaluations = candidates.map((w) => this.evaluateWorkerAvailability(w));

    // Filter to workers that are available AND support the required job capability
    const eligible = candidates.filter((w) => {
      const evalResult = evaluations.find((e) => e.workerId === w.id);
      if (!evalResult || !evalResult.isAvailable) return false;
      const caps = evalResult.capabilities || [];
      return caps.includes(jobType);
    });

    if (eligible.length === 0) {
      const reasons = evaluations
        .map((e) => `${e.machineCode}: ${e.exclusionReason || 'missing capability'}`)
        .join('; ');
      return {
        selected: null,
        reason: `No eligible workers available. Candidates evaluated (${candidates.length}): [${reasons || 'None registered'}]`,
        candidateEvaluations: evaluations,
      };
    }

    // Sort by documented Least-Loaded First policy:
    // 1. Fewest active jobs
    // 2. Lowest capacity utilization ratio (currentActiveJobs / maxConcurrentJobs)
    // 3. Lowest combined resource load (cpuUsage + memoryUsage)
    // 4. Oldest lastJobAt (fair distribution / round-robin)
    // 5. Deterministic tie-breaker: machineCode asc
    const sorted = [...eligible].sort((a, b) => {
      const activeA = a.currentActiveJobs ?? 0;
      const activeB = b.currentActiveJobs ?? 0;
      if (activeA !== activeB) return activeA - activeB;

      const maxA = a.maxConcurrentJobs || 1;
      const maxB = b.maxConcurrentJobs || 1;
      const ratioA = activeA / maxA;
      const ratioB = activeB / maxB;
      if (ratioA !== ratioB) return ratioA - ratioB;

      const loadA = (a.cpuUsage ?? 0) + (a.memoryUsage ?? 0);
      const loadB = (b.cpuUsage ?? 0) + (b.memoryUsage ?? 0);
      if (loadA !== loadB) return loadA - loadB;

      const timeA = a.lastJobAt ? new Date(a.lastJobAt).getTime() : 0;
      const timeB = b.lastJobAt ? new Date(b.lastJobAt).getTime() : 0;
      if (timeA !== timeB) return timeA - timeB;

      return a.machineCode.localeCompare(b.machineCode);
    });

    const best = sorted[0];
    const bestEval = evaluations.find((e) => e.workerId === best.id);
    const reason = `Selected least-loaded worker ${best.machineCode} (${best.currentActiveJobs ?? 0}/${best.maxConcurrentJobs ?? 1} jobs, CPU ${best.cpuUsage ?? 0}%, RAM ${best.memoryUsage ?? 0}%) from ${eligible.length} eligible candidates.`;

    return {
      selected: best,
      reason,
      candidateEvaluations: evaluations,
    };
  }

  /**
   * Automatically allocates an eligible job to the best available worker.
   * Performs an atomic database transaction with conditional locking to prevent double assignment.
   */
  async allocateJob(jobId: string): Promise<AllocationResult> {
    const job = await this.prisma.bookingJob.findUnique({
      where: { id: jobId },
      include: {
        account: true,
        bookingRequest: {
          include: { account: true },
        },
      },
    });

    if (!job) {
      throw new NotFoundException(`Job with ID ${jobId} not found`);
    }

    const eligibleStatuses: BookingStatus[] = [
      BookingStatus.QUEUED,
      BookingStatus.EXECUTION_QUEUED,
      ((BookingStatus as any).FAST_BOOKING_QUEUED || 'FAST_BOOKING_QUEUED') as any,
    ];

    if (!eligibleStatuses.includes(job.status)) {
      return {
        allocated: false,
        jobId: job.id,
        decisionReason: `Job is in '${job.status}' status (not eligible for initial allocation).`,
      };
    }

    // Guard 1: Terminal / already-confirmed bookings MUST NOT be allocated or acquire account locks.
    // Auto-close orphaned jobs whose booking is already terminal (CANCELLED, COMPLETED, SUCCESS, FAILED, EXPIRED).
    const allocBooking = job.bookingRequest as any;
    if (allocBooking) {
      const storedRef = extractAuthoritativeReference(allocBooking);
      const isTerminalSuccess =
        allocBooking.status === BookingStatus.SUCCESS ||
        allocBooking.status === BookingStatus.COMPLETED ||
        allocBooking.status === 'BOOKING_CONFIRMED' ||
        Boolean(storedRef);
      const isTerminalClosed =
        isTerminalSuccess || TERMINAL_OR_EXCLUDED_BOOKING_STATUSES.includes(allocBooking.status);

      if (isTerminalClosed) {
        const closedJobStatus = isTerminalSuccess ? BookingStatus.SUCCESS : BookingStatus.CANCELLED;
        this.logger.log(
          `[ALLOCATOR] Closing orphaned Job #${job.id} (${job.status} -> ${closedJobStatus}): Booking #${allocBooking.bookingCode} is in terminal status (${allocBooking.status}).`,
        );
        await Promise.resolve(
          this.prisma.bookingJob.update({
            where: { id: job.id },
            data: {
              status: closedJobStatus,
              workerId: null,
              leaseExpiresAt: null,
              completedAt: new Date(),
            },
          }),
        ).catch(() => {});
        return {
          allocated: false,
          jobId: job.id,
          decisionReason: `Booking #${allocBooking.bookingCode} is in terminal status (${allocBooking.status}). Orphaned job closed.`,
        };
      }

      // Guard 2: Skip WATCHING bookings unless their date/route is currently AVAILABLE in availability cache
      if (allocBooking.status === BookingStatus.WATCHING) {
        const dateStr =
          allocBooking.requestedDateStr ||
          (allocBooking.requestedDate instanceof Date
            ? allocBooking.requestedDate.toISOString().split('T')[0]
            : String(allocBooking.requestedDate || '').split('T')[0]);
        const isAvail = await this.isDateRouteAvailableInCache(dateStr, allocBooking.route);
        if (!isAvail.available) {
          return {
            allocated: false,
            jobId: job.id,
            decisionReason: `Booking #${allocBooking.bookingCode} is WATCHING and date ${dateStr} is not AVAILABLE in cache (status=${isAvail.status}).`,
          };
        }
      }

      // Guard 3: Validate state machine transitionability BEFORE acquiring an account lock
      if (
        this.stateMachine &&
        typeof this.stateMachine.canTransition === 'function' &&
        !this.stateMachine.canTransition(allocBooking.status, BookingStatus.EXECUTING)
      ) {
        this.logger.warn(
          `[ALLOCATOR] Skipping Job #${job.id}: Booking #${allocBooking.bookingCode} cannot transition ${allocBooking.status} -> EXECUTING.`,
        );
        return {
          allocated: false,
          jobId: job.id,
          decisionReason: `Invalid state transition prevented before locking: ${allocBooking.status} -> EXECUTING`,
        };
      }
    }

    // 0. Mandatory Nominee Pre-Validation: Validate before any worker allocation
    if (job.bookingRequestId && job.bookingRequest) {
      const nomineeResult = validateNominee(job.bookingRequest);
      if (!nomineeResult.valid) {
        this.logger.warn(
          `[ALLOCATOR] Holding Job #${job.id} / Booking #${job.bookingRequest.bookingCode}: Mandatory nominee validation failed: ${nomineeResult.errors.join('; ')}`,
        );
        await this.prisma.$transaction(async (tx) => {
          await tx.bookingJob.update({
            where: { id: job.id },
            data: {
              status: BookingStatus.HOLD_INVALID_NOMINEE,
              errorMessage: `HOLD_INVALID_NOMINEE: ${nomineeResult.errors.join('; ')}`,
            },
          });
          await tx.bookingRequest.update({
            where: { id: job.bookingRequestId! },
            data: {
              status: BookingStatus.HOLD_INVALID_NOMINEE,
              requiresHumanNote: `HOLD_INVALID_NOMINEE: ${nomineeResult.errors.join('; ')}`,
            },
          });
          if ((tx as any).bookingMilestone?.create) {
            await tx.bookingMilestone.create({
              data: {
                bookingRequestId: job.bookingRequestId!,
                milestone: 'NOMINEE_VALIDATION_FAILED',
                metadata: { errors: nomineeResult.errors },
              },
            });
          }
        });

        return {
          allocated: false,
          jobId: job.id,
          decisionReason: `Mandatory nominee validation failed: ${nomineeResult.errors.join('; ')}. Booking placed on HOLD_INVALID_NOMINEE.`,
        };
      }
    }

    // 1. Check account lock if linked to an account
    const account = job.account || job.bookingRequest?.account;
    if (account?.status === ('ACCOUNT_PREVIOUS_BOOKING_RESTRICTED' as any) || account?.status === 'DISABLED') {
      return {
        allocated: false,
        jobId: job.id,
        decisionReason: `Account '${account.username}' is restricted (${account.status}). Retries stopped.`,
      };
    }
    if (account?.id && job.bookingRequestId) {
      const lockAcquired = await this.accountLockService.acquireLock(account.id, job.bookingRequestId);
      if (!lockAcquired) {
        return {
          allocated: false,
          jobId: job.id,
          decisionReason: `Account '${account.username}' is currently locked by another active booking.`,
        };
      }
    }

    // 2. Fetch all registered candidate workers
    const candidateWorkers = await this.prisma.workerMachine.findMany({
      where: {
        active: true,
        adminStatus: 'ENABLED',
        desiredState: 'RUNNING',
      },
      orderBy: { machineCode: 'asc' },
    });

    const { selected, reason, candidateEvaluations } = this.selectBestWorker(
      candidateWorkers,
      job.jobType,
    );

    if (!selected) {
      // Record allocation log for observability
      await this.prisma.jobAllocationLog.create({
        data: {
          jobId: job.id,
          bookingId: job.bookingRequestId || null,
          workerId: null,
          status: 'NO_WORKER_AVAILABLE',
          decisionReason: reason,
          candidateCount: candidateWorkers.length,
          evaluatedWorkers: candidateEvaluations as any,
        },
      });

      return {
        allocated: false,
        jobId: job.id,
        decisionReason: reason,
        candidateCount: candidateWorkers.length,
        evaluatedWorkers: candidateEvaluations,
      };
    }

    // 3. Atomically reserve job and worker capacity inside transaction
    const now = new Date();
    const leaseExpiry = new Date(now.getTime() + this.DEFAULT_LEASE_DURATION_SEC * 1000);
    const leaseId = `lease_${job.id.slice(0, 8)}_${Date.now()}`;

    try {
      const allocationTx = await this.prisma.$transaction(async (tx) => {
        const txAny = tx as any;
        // Atomic conditional check: verify job is STILL in expected queued status
        const currentJob = await txAny.bookingJob.findUnique({
          where: { id: job.id },
          select: { leaseGeneration: true, version: true },
        });

        const nextLeaseGeneration = (currentJob?.leaseGeneration || 0) + 1;
        const fencingToken = `fnc_${job.id}_gen${nextLeaseGeneration}_${selected.id.slice(0, 8)}`;

        const updateCount = await txAny.bookingJob.updateMany({
          where: {
            id: job.id,
            status: job.status,
          },
          data: {
            workerId: selected.id,
            status: BookingStatus.WORKER_ASSIGNED,
            startedAt: now,
            heartbeatAt: now,
            leaseExpiresAt: leaseExpiry,
            leaseId,
            leaseGeneration: nextLeaseGeneration,
            fencingToken,
            version: { increment: 1 },
            attempt: { increment: 1 },
          },
        });

        if (updateCount.count === 0) {
          throw new ConflictException('Job was concurrently allocated or claimed by another process.');
        }

        // Update BookingRequest if applicable
        if (job.bookingRequestId) {
          if (this.stateMachine) {
            await this.stateMachine.transition({
              bookingId: job.bookingRequestId,
              targetStatus: BookingStatus.EXECUTING,
              targetExecutionStatus: 'RUNNING',
              assignedMachineId: selected.id,
              leaseStartedAt: now,
              leaseExpiresAt: leaseExpiry,
              milestone: 'ALLOCATED_BY_SMART_ALLOCATOR',
              operator: 'SmartAllocatorService',
            }, tx);
          } else {
            await txAny.bookingRequest.update({
              where: { id: job.bookingRequestId },
              data: {
                assignedMachineId: selected.id,
                leaseStartedAt: now,
                leaseExpiresAt: leaseExpiry,
                status: BookingStatus.EXECUTING,
                version: { increment: 1 },
                executionStatus: 'RUNNING',
              },
            });
          }
        }

        // Increment worker capacity counter and record assignment
        const updatedWorker = await tx.workerMachine.update({
          where: { id: selected.id },
          data: {
            currentActiveJobs: { increment: 1 },
            status: WorkerStatus.BUSY,
            currentJobId: job.id,
            currentBookingId: job.bookingRequestId || null,
            lastJobAt: now,
            lastActivityAt: now,
            currentActivity: 'PROCESSING_JOB',
            activityDetails: `Allocated ${job.jobType} #${job.id.slice(0, 8)}`,
          },
        });

        // Record structured allocation decision log
        const allocLog = await tx.jobAllocationLog.create({
          data: {
            jobId: job.id,
            bookingId: job.bookingRequestId || null,
            workerId: selected.id,
            status: 'ALLOCATED',
            decisionReason: reason,
            candidateCount: candidateWorkers.length,
            evaluatedWorkers: candidateEvaluations as any,
          },
        });

        // Record worker activity timeline event
        await tx.workerActivityLog.create({
          data: {
            workerId: selected.id,
            jobId: job.id,
            bookingId: job.bookingRequestId || null,
            eventType: 'JOB_CLAIMED',
            severity: 'INFO',
            activity: 'PROCESSING_JOB',
            message: `Smart Allocator reserved job #${job.id.slice(0, 8)} (${job.jobType}). Capacity: ${updatedWorker.currentActiveJobs}/${updatedWorker.maxConcurrentJobs}`,
          },
        });

        return { updatedWorker, allocLog };
      });

      // 4. Notify admins and workers via WebSockets
      if (this.eventsGateway) {
        this.eventsGateway.emitToAdmins('job:allocated', {
          jobId: job.id,
          workerId: selected.id,
          machineCode: selected.machineCode,
          decisionReason: reason,
        });

        this.eventsGateway.notifyFleetUpdated(selected.machineCode, {
          status: WorkerStatus.BUSY,
          currentActiveJobs: allocationTx.updatedWorker.currentActiveJobs,
          currentJobId: job.id,
        });
      }

      this.logger.log(`[ALLOCATION] Successfully allocated job #${job.id} to ${selected.machineCode}`);

      return {
        allocated: true,
        jobId: job.id,
        workerId: selected.id,
        machineCode: selected.machineCode,
        decisionReason: reason,
        candidateCount: candidateWorkers.length,
      };
    } catch (err: any) {
      // If transaction failed or raced, release account lock safely
      if (account?.id && job.bookingRequestId) {
        await this.accountLockService.releaseLock(account.id, job.bookingRequestId);
      }
      this.logger.warn(`[ALLOCATION] Allocation failed for job #${job.id}: ${err.message}`);
      return {
        allocated: false,
        jobId: job.id,
        decisionReason: `Allocation conflict or failure: ${err.message}`,
      };
    }
  }

  /**
   * Finds the oldest eligible pending job in the queue and allocates it.
   */
  async allocateNextPendingJob(): Promise<AllocationResult | null> {
    // Priority 1: Oldest pending Account Verification
    const nextVerification = await this.prisma.bookingJob.findFirst({
      where: {
        jobType: JobType.ACCOUNT_VERIFICATION,
        status: BookingStatus.QUEUED,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (nextVerification) {
      return this.allocateJob(nextVerification.id);
    }

    // Priority 2: Oldest pending Booking Execution (join bookingRequest to exclude terminal & WATCHING bookings)
    const nextBooking = await this.prisma.bookingJob.findFirst({
      where: {
        jobType: JobType.BOOKING_EXECUTION,
        status: {
          in: [
            BookingStatus.QUEUED,
            BookingStatus.EXECUTION_QUEUED,
            ((BookingStatus as any).FAST_BOOKING_QUEUED || 'FAST_BOOKING_QUEUED') as any,
          ],
        },
        bookingRequest: {
          status: {
            notIn: [...TERMINAL_OR_EXCLUDED_BOOKING_STATUSES, BookingStatus.WATCHING],
          },
          officialBookingReference: null,
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (nextBooking) {
      return this.allocateJob(nextBooking.id);
    }

    return null;
  }

  /**
   * Checks whether a date/route is currently AVAILABLE in the server availability cache
   * (DiscoverySchedule or active AVAILABLE AvailabilityOpportunity).
   */
  async isDateRouteAvailableInCache(
    dateStr?: string | null,
    route?: string | null,
  ): Promise<{ available: boolean; status: string }> {
    if (!dateStr) return { available: false, status: 'NO_DATE' };

    const demandKey = normalizeDemandKey(dateStr, route || 'Pamba');
    const prismaAny = this.prisma as any;

    try {
      if (typeof prismaAny.discoverySchedule?.findUnique === 'function') {
        const sched = await prismaAny.discoverySchedule.findUnique({
          where: { demandKey },
        });
        if (sched) {
          if (sched.status === 'AVAILABLE') {
            return { available: true, status: 'AVAILABLE' };
          }
          // Even if schedule says UNAVAILABLE/UNKNOWN, check if a fresh AVAILABLE opportunity exists
          if (typeof prismaAny.availabilityOpportunity?.findFirst === 'function') {
            const availOpp = await prismaAny.availabilityOpportunity.findFirst({
              where: { date: dateStr, status: 'AVAILABLE' },
            });
            if (availOpp) {
              return { available: true, status: 'AVAILABLE_OPPORTUNITY' };
            }
          }
          return { available: false, status: sched.status || 'UNAVAILABLE' };
        }
      }

      if (typeof prismaAny.availabilityOpportunity?.findFirst === 'function') {
        const availOpp = await prismaAny.availabilityOpportunity.findFirst({
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
   * Periodic or event-driven sweep of all pending jobs against all available worker capacity.
   */
  async runAllocationSweep(): Promise<{ allocatedCount: number; pendingCount: number }> {
    if (this.isSweepRunning) return { allocatedCount: 0, pendingCount: 0 };
    this.isSweepRunning = true;

    try {
      let allocatedCount = 0;
      const pendingJobs = await this.prisma.bookingJob.findMany({
        where: {
          status: {
            in: [
              BookingStatus.QUEUED,
              BookingStatus.EXECUTION_QUEUED,
              ((BookingStatus as any).FAST_BOOKING_QUEUED || 'FAST_BOOKING_QUEUED') as any,
            ],
          },
          OR: [
            { jobType: JobType.ACCOUNT_VERIFICATION },
            {
              bookingRequest: {
                status: {
                  notIn: [...TERMINAL_OR_EXCLUDED_BOOKING_STATUSES, BookingStatus.WATCHING],
                },
                officialBookingReference: null,
              },
            },
          ],
        },
        orderBy: [{ jobType: 'asc' }, { createdAt: 'asc' }],
        take: 25,
      });

      for (const job of pendingJobs) {
        const res = await this.allocateJob(job.id);
        if (res.allocated) {
          allocatedCount++;
        }
      }

      return {
        allocatedCount,
        pendingCount: pendingJobs.length,
      };
    } finally {
      this.isSweepRunning = false;
    }
  }

  /**
   * Safely releases capacity when a job completes or fails.
   * Guarantees capacity counter never drops below 0.
   */
  async releaseJobCapacity(
    workerId: string,
    jobId: string,
    bookingId?: string | null,
    triggerNextAllocation: boolean = true,
  ): Promise<void> {
    try {
      const worker = await this.prisma.workerMachine.findUnique({
        where: { id: workerId },
      });

      if (!worker) return;

      const newActiveJobs = Math.max(0, (worker.currentActiveJobs ?? 1) - 1);
      const isNowIdle = newActiveJobs === 0;

      await this.prisma.workerMachine.update({
        where: { id: workerId },
        data: {
          currentActiveJobs: newActiveJobs,
          status: isNowIdle ? WorkerStatus.ONLINE : WorkerStatus.BUSY,
          currentJobId: isNowIdle ? null : worker.currentJobId,
          currentBookingId: isNowIdle ? null : worker.currentBookingId,
          currentActivity: isNowIdle ? 'IDLE' : worker.currentActivity,
          activityDetails: isNowIdle ? 'Idle, waiting for assignments' : worker.activityDetails,
        },
      });

      // Immediately trigger next job allocation for this newly freed capacity if enabled
      if (triggerNextAllocation) {
        this.allocateNextPendingJob().catch(() => {});
      }
    } catch (err: any) {
      this.logger.warn(`Failed to release capacity for worker ${workerId}: ${err.message}`);
    }
  }

  /**
   * Authoritatively evaluates active capacity for a worker by inspecting only RUNNING jobs
   * with unexpired leases (strictly excluding COMPLETED, WATCHING, NEEDS_REVIEW with official
   * reference, and jobs with expired leases). Logs the full capacity decision.
   */
  async evaluateWorkerCapacity(
    workerId: string,
    maxCapacity?: number,
    workerReportedActiveJobIds?: string[],
    syncMachine: boolean = true,
  ): Promise<{
    activeCount: number;
    maxCapacity: number;
    countedJobs: Array<{ jobId: string; bookingCode?: string; status: string; reason: string; leaseRemainingSec?: number; bookingRequestId?: string | null }>;
    excludedJobs: Array<{ jobId: string; bookingCode?: string; status: string; reason: string }>;
  }> {
    const now = new Date();
    let effectiveLimit = maxCapacity;
    let machineCode = workerId;

    if (effectiveLimit === undefined && typeof this.prisma.workerMachine?.findUnique === 'function') {
      const w = await this.prisma.workerMachine.findUnique({ where: { id: workerId } }).catch(() => null);
      if (w) {
        effectiveLimit = (w as any).maxConcurrentJobs ?? 1;
        machineCode = w.machineCode || workerId;
      }
    }
    const limit = effectiveLimit ?? 1;

    const countedJobs: Array<{ jobId: string; bookingCode?: string; status: string; reason: string; leaseRemainingSec?: number; bookingRequestId?: string | null }> = [];
    const excludedJobs: Array<{ jobId: string; bookingCode?: string; status: string; reason: string }> = [];

    if (typeof this.prisma.bookingJob?.findMany === 'function') {
      const workerJobs = await this.prisma.bookingJob.findMany({
        where: {
          workerId,
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
            },
          },
        },
      });

      for (const job of workerJobs) {
        if (job.workerId !== workerId) continue;
        const evalRes = evaluateJobActiveCapacity(job as any, now, workerReportedActiveJobIds);
        const bookingCode = (job as any).bookingRequest?.bookingCode;
        if (evalRes.counts) {
          countedJobs.push({
            jobId: job.id,
            bookingCode,
            status: job.status,
            reason: evalRes.reason,
            leaseRemainingSec: evalRes.leaseRemainingSec,
            bookingRequestId: job.bookingRequestId,
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
    } else if (typeof this.prisma.bookingJob?.count === 'function') {
      const fallbackCount = await this.prisma.bookingJob.count({
        where: {
          workerId,
          status: { in: ACTIVE_RUNNING_JOB_STATUSES },
          leaseExpiresAt: { gt: now },
        },
      });
      for (let i = 0; i < fallbackCount; i++) {
        countedJobs.push({
          jobId: `active-${i + 1}`,
          status: 'EXECUTING',
          reason: 'RUNNING(unexpired lease)',
        });
      }
    }

    const activeCount = countedJobs.length;
    const countedSummary = countedJobs.length > 0
      ? countedJobs.map((j) => `${j.jobId}(${j.bookingCode || 'N/A'}:${j.reason})`).join(', ')
      : 'none';
    const excludedSummary = excludedJobs.length > 0
      ? excludedJobs.slice(0, 8).map((j) => `${j.jobId}(${j.bookingCode || 'N/A'}:${j.reason})`).join(', ')
      : 'none';

    this.logger.log(
      `[CAPACITY] Worker ${machineCode}: active=${activeCount}/${limit} | counted=[${countedSummary}] | excluded=[${excludedSummary}]`,
    );

    if (syncMachine && typeof this.prisma.workerMachine?.update === 'function') {
      await Promise.resolve(
        this.prisma.workerMachine.update({
          where: { id: workerId },
          data: {
            currentActiveJobs: activeCount,
            status: activeCount > 0 ? WorkerStatus.BUSY : WorkerStatus.ONLINE,
            ...(activeCount === 0
              ? {
                  currentJobId: null,
                  currentBookingId: null,
                  currentActivity: 'IDLE',
                  activityDetails: 'Idle, waiting for assignments',
                }
              : {}),
          },
        }),
      ).catch(() => {});
    }

    return { activeCount, maxCapacity: limit, countedJobs, excludedJobs };
  }

  /**
   * Reconciles authoritative capacity counters by checking active unexpired database leases.
   */
  async reconcileWorkerCapacity(workerId: string, workerReportedActiveJobIds?: string[]): Promise<number> {
    const res = await this.evaluateWorkerCapacity(workerId, undefined, workerReportedActiveJobIds, true);
    return res.activeCount;
  }

  /**
   * Recovers expired worker reservations with strict safety controls.
   * If outcome is ambiguous or external site submission occurred, flags for human review.
   */
  async recoverStaleLeases(): Promise<{
    recoveredCount: number;
    humanReviewCount: number;
    totalRecovered?: number;
    staleLeasesRecovered?: number;
    recreatedJobsCount?: number;
    requeuedAccountsCount?: number;
    retryableRequeuedCount?: number;
    expiredLocksCleaned?: number;
    pastBookingsAutoCancelled?: number;
    uncompletedPassesReconciled?: number;
    orphanedTerminalJobsClosed?: number;
    details?: string[];
  }> {
    const now = new Date();
    const details: string[] = [];

    // 1. Recover stale/expired worker leases (isolated in its own try/catch)
    let recoveredCount = 0;
    let humanReviewCount = 0;
    try {
      const expiredJobs = await this.prisma.bookingJob.findMany({
        where: {
          status: {
            in: [
              BookingStatus.WORKER_ASSIGNED,
              BookingStatus.EXECUTING,
              BookingStatus.CHECKING_AVAILABILITY,
            ],
          },
          leaseExpiresAt: { lte: now },
        },
        include: { worker: true, bookingRequest: true },
      });

      for (const job of expiredJobs) {
      try {
        const assignedWorkerId = job.workerId;

        // Safety: If job reached site submission or verification (e.g. CONFIRM_CLICKED), external booking could exist
        const lastMilestoneStr = String(job.lastMilestone || job.bookingRequest?.lastMilestone || '');
        const isConfirmClickedMilestone =
          lastMilestoneStr === 'CONFIRM_CLICKED' ||
          lastMilestoneStr === 'PAYMENT_PROCEED_CLICKED' ||
          lastMilestoneStr === 'ZERO_COST_CONFIRMATION_PENDING' ||
          lastMilestoneStr === 'CONFIRMATION_PENDING';

        const isAmbiguous =
          job.status === BookingStatus.EXECUTING &&
          job.bookingRequest?.officialReference === null &&
          (isConfirmClickedMilestone || (job.attempt || 0) > 1);

        if (isAmbiguous) {
          const targetQuarantineStatus = isConfirmClickedMilestone
            ? BookingStatus.PENDING_VERIFICATION
            : BookingStatus.REQUIRES_HUMAN;

          // Escalate to PENDING_VERIFICATION / REQUIRES_HUMAN to prevent duplicate portal booking
          await this.prisma.bookingJob.update({
            where: { id: job.id },
            data: {
              status: targetQuarantineStatus,
              errorMessage: 'Worker lease expired during active execution. Ambiguous portal state requires verification.',
            },
          });

          if (job.bookingRequestId) {
            if (this.stateMachine) {
              await this.stateMachine.transition({
                bookingId: job.bookingRequestId,
                targetStatus: targetQuarantineStatus,
                note: 'Worker lease expired during execution. Check Sabarimala portal before retrying.',
                reason: 'Worker lease expired during active execution. Ambiguous portal state requires verification.',
                milestone: isConfirmClickedMilestone ? 'EXPIRED_AFTER_CONFIRM_CLICK' : 'STALE_LEASE_REAPED_TO_HUMAN',
                operator: 'SmartAllocatorService:reapStaleLeases',
              });
            } else {
              await this.prisma.bookingRequest.update({
                where: { id: job.bookingRequestId },
                data: {
                  status: targetQuarantineStatus,
                  requiresHumanNote: 'Worker lease expired during execution. Check Sabarimala portal before retrying.',
                },
              });
            }
          }

          humanReviewCount++;
          details.push(`Lease expired for Job #${job.id} during active execution; escalated to REQUIRES_HUMAN.`);
        } else {
          // Safe to recover back to queue
          await this.prisma.bookingJob.update({
            where: { id: job.id },
            data: {
              status: BookingStatus.QUEUED,
              workerId: null,
              heartbeatAt: null,
              leaseExpiresAt: null,
            },
          });

          if (job.bookingRequestId) {
            if (this.stateMachine) {
              await this.stateMachine.transition({
                bookingId: job.bookingRequestId,
                targetStatus: BookingStatus.QUEUED,
                assignedMachineId: null,
                leaseStartedAt: null,
                leaseExpiresAt: null,
                reason: 'Worker lease expired before critical stage. Recovered to queue.',
                milestone: 'STALE_LEASE_RECOVERED_TO_QUEUE',
                operator: 'SmartAllocatorService:reapStaleLeases',
              });
            } else {
              await this.prisma.bookingRequest.update({
                where: { id: job.bookingRequestId },
                data: {
                  status: BookingStatus.QUEUED,
                  assignedMachineId: null,
                  leaseStartedAt: null,
                  leaseExpiresAt: null,
                },
              });
            }
          }

          recoveredCount++;
          details.push(`Recovered stale Job #${job.id} back to QUEUED.`);
        }

        // Release capacity on the assigned worker without immediately reallocating to it
        if (assignedWorkerId) {
          await this.releaseJobCapacity(assignedWorkerId, job.id, job.bookingRequestId, false);
        }

        await this.prisma.jobAllocationLog.create({
          data: {
            jobId: job.id,
            bookingId: job.bookingRequestId || null,
            workerId: assignedWorkerId || null,
            status: isAmbiguous ? 'REJECTED' : 'RECOVERED',
            decisionReason: isAmbiguous
              ? 'Lease expired during ambiguous execution; escalated to human review.'
              : 'Expired lease safely recovered back to queue.',
          },
        });
      } catch (err: any) {
        this.logger.warn(`Error recovering stale job #${job.id}: ${err.message}`);
      }
      }
    } catch (staleSweepErr: any) {
      this.logger.warn(`Reconcile stale leases sweep error: ${staleSweepErr.message}`);
    }

    // 2. Reconcile EXECUTION_QUEUED requests: recreate job as QUEUED if missing, or reset request to PENDING
    let recreatedJobsCount = 0;
    try {
      const executionQueuedRequests = typeof this.prisma.bookingRequest?.findMany === 'function'
        ? await this.prisma.bookingRequest.findMany({
            where: { status: { in: [BookingStatus.EXECUTION_QUEUED] } },
            include: { jobs: true },
          })
        : [];

      for (const br of executionQueuedRequests) {
        const brJob = (br as any).jobs && (br as any).jobs.length > 0 ? (br as any).jobs[0] : null;
        const activeJobStatuses: any[] = [
          BookingStatus.QUEUED,
          BookingStatus.EXECUTING,
          BookingStatus.WORKER_ASSIGNED,
          BookingStatus.LOGIN_IN_PROGRESS,
          BookingStatus.BOOKING_IN_PROGRESS,
        ];
        const hasActiveJob = brJob && activeJobStatuses.includes(brJob.status) && (
          brJob.status !== BookingStatus.EXECUTING || (brJob.leaseExpiresAt && new Date(brJob.leaseExpiresAt).getTime() > now.getTime())
        );

        if (!hasActiveJob) {
          try {
            if (brJob) {
              await this.prisma.bookingJob.update({
                where: { id: brJob.id },
                data: {
                  status: BookingStatus.QUEUED,
                  workerId: null,
                  startedAt: null,
                  heartbeatAt: null,
                  leaseExpiresAt: null,
                },
              });
            } else {
              await this.prisma.bookingJob.create({
                data: {
                  jobType: JobType.BOOKING_EXECUTION,
                  bookingRequestId: br.id,
                  accountId: br.accountId || null,
                  workerId: null,
                  status: BookingStatus.QUEUED,
                },
              });
            }
            recreatedJobsCount++;
            details.push(`Recreated QUEUED job for EXECUTION_QUEUED booking #${br.bookingCode}`);
          } catch (jobErr: any) {
            this.logger.warn(`Failed to recreate job for #${br.bookingCode}: ${jobErr.message}. Resetting request to PENDING.`);
            await this.prisma.bookingRequest.update({
              where: { id: br.id },
              data: { status: BookingStatus.PENDING, assignedMachineId: null, leaseExpiresAt: null },
            }).catch(() => {});
            details.push(`Reset EXECUTION_QUEUED booking #${br.bookingCode} to PENDING (job recreate failed)`);
          }
        }
      }
    } catch (recErr: any) {
      this.logger.warn(`Reconcile EXECUTION_QUEUED error: ${recErr.message}`);
    }

    // 3. Reconcile WAITING_FOR_ACCOUNT requests: requeue if account is now free
    let requeuedAccountsCount = 0;
    try {
      const waitingForAccountRequests = typeof this.prisma.bookingRequest?.findMany === 'function'
        ? await this.prisma.bookingRequest.findMany({
            where: { status: { in: [BookingStatus.WAITING_FOR_ACCOUNT] } },
            include: { jobs: true },
          })
        : [];

      for (const br of waitingForAccountRequests) {
        const brJob = (br as any).jobs && (br as any).jobs.length > 0 ? (br as any).jobs[0] : null;
        if (br.accountId) {
          const isLocked = await this.accountLockService.isLocked(br.accountId, br.id);
          if (!isLocked) {
            try {
              if (this.stateMachine) {
                await this.stateMachine.transition({
                  bookingId: br.id,
                  targetStatus: BookingStatus.QUEUED,
                  milestone: 'ACCOUNT_FREED_REQUEUED',
                  reason: 'Devotee account is free; requeued by Reconciler.',
                }).catch(() => {});
              } else {
                await this.prisma.bookingRequest.update({
                  where: { id: br.id },
                  data: { status: BookingStatus.QUEUED },
                });
              }

              if (brJob) {
                await this.prisma.bookingJob.update({
                  where: { id: brJob.id },
                  data: { status: BookingStatus.QUEUED, workerId: null, leaseExpiresAt: null },
                });
              } else {
                await this.prisma.bookingJob.create({
                  data: {
                    jobType: JobType.BOOKING_EXECUTION,
                    bookingRequestId: br.id,
                    accountId: br.accountId,
                    workerId: null,
                    status: BookingStatus.QUEUED,
                  },
                }).catch(() => {});
              }

              requeuedAccountsCount++;
              details.push(`Requeued WAITING_FOR_ACCOUNT booking #${br.bookingCode} (account freed)`);
            } catch (err: any) {
              this.logger.warn(`Error requeueing WAITING_FOR_ACCOUNT booking #${br.bookingCode}: ${err.message}`);
            }
          }
        }
      }
    } catch (accErr: any) {
      this.logger.warn(`Reconcile WAITING_FOR_ACCOUNT error: ${accErr.message}`);
    }

    // 4. Reconcile RETRYABLE_FAILURE jobs: return to QUEUED when nextRetryAt/cooldown has passed
    let retryableRequeuedCount = 0;
    try {
      const retryableJobs = await this.prisma.bookingJob.findMany({
        where: { status: { in: [BookingStatus.RETRYABLE_FAILURE] } },
        include: { bookingRequest: true },
      });

      for (const rj of retryableJobs) {
        const nextRetryAt = (rj as any).nextRetryAt || rj.bookingRequest?.nextCheckAt;
        const isRetryDue = !nextRetryAt || new Date(nextRetryAt).getTime() <= now.getTime();

        if (isRetryDue) {
          try {
            await this.prisma.bookingJob.update({
              where: { id: rj.id },
              data: {
                status: BookingStatus.QUEUED,
                workerId: null,
                heartbeatAt: null,
                leaseExpiresAt: null,
              },
            });

            if (rj.bookingRequestId) {
              if (this.stateMachine) {
                await this.stateMachine.transition({
                  bookingId: rj.bookingRequestId,
                  targetStatus: BookingStatus.QUEUED,
                  milestone: 'RETRYABLE_FAILURE_COOLDOWN_ELAPSED',
                  reason: 'Retryable cooldown elapsed; job returned to queue.',
                }).catch(() => {});
              } else {
                await this.prisma.bookingRequest.update({
                  where: { id: rj.bookingRequestId },
                  data: { status: BookingStatus.QUEUED, nextCheckAt: null },
                });
              }
            }

            retryableRequeuedCount++;
            details.push(`Returned RETRYABLE_FAILURE job #${rj.id} to QUEUED (cooldown elapsed)`);
          } catch (err: any) {
            this.logger.warn(`Error requeueing RETRYABLE_FAILURE job #${rj.id}: ${err.message}`);
          }
        }
      }
    } catch (retErr: any) {
      this.logger.warn(`Reconcile RETRYABLE_FAILURE error: ${retErr.message}`);
    }

    // 5. Clean expired / orphaned account locks
    let expiredLocksCleaned = 0;
    try {
      expiredLocksCleaned = await this.accountLockService.cleanupExpiredLocks();
      if (expiredLocksCleaned > 0) {
        details.push(`Cleaned ${expiredLocksCleaned} expired/stale account lock(s)`);
      }
    } catch (_) {}

    // 6. Auto-cancel past-date pending bookings system-wide
    let pastBookingsAutoCancelled = 0;
    try {
      if (this.bookingsService) {
        const autoCancelRes = await this.bookingsService.autoCancelPastPendingBookings();
        pastBookingsAutoCancelled = autoCancelRes.cancelledCount;
        if (autoCancelRes.details.length > 0) {
          details.push(...autoCancelRes.details);
        }
      }
    } catch (err: any) {
      this.logger.warn(`Reconciler past bookings auto-cancel error: ${err.message}`);
    }

    // 7a. Reconcile bookings with an official reference whose status is not COMPLETED/SUCCESS (isolated try/catch)
    let uncompletedPassesReconciled = 0;
    let uncompletedPassesQuerySucceeded = false;
    try {
      const pendingConfirmedBookings = await this.prisma.bookingRequest.findMany({
        where: {
          officialBookingReference: { not: null },
          status: { notIn: [BookingStatus.SUCCESS, BookingStatus.COMPLETED, BookingStatus.CANCELLED] },
        },
        include: { jobs: true, pilgrims: true },
      });
      uncompletedPassesQuerySucceeded = true;

      for (const br of pendingConfirmedBookings) {
        try {
          const totalRequested = Math.max(1, br.pilgrimCount || 1);
          if (totalRequested > 1 && (br as any).pilgrims && (br as any).pilgrims.length > 0) {
            const completedCount = (br as any).pilgrims.filter((p: any) => {
              const meta = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : (p.metadata || {});
              return (
                meta.taskStatus === 'CONFIRMED' ||
                meta.taskStatus === 'ADMIN_COMPLETED' ||
                meta.status === 'CONFIRMED' ||
                meta.status === 'ADMIN_COMPLETED' ||
                !!meta.officialBookingReference ||
                !!meta.portalTransactionReference ||
                !!meta.transactionId
              );
            }).length;
            if (completedCount < totalRequested) {
              this.logger.log(`[SmartAllocator] Preserving PARTIALLY_CONFIRMED for booking #${br.bookingCode} (${completedCount}/${totalRequested} devotees completed). Skipping premature auto-completion.`);
              continue;
            }
          }

          const passRef = extractAuthoritativeReference(br);
          if (passRef) {
            const brJob = br.jobs && br.jobs.length > 0 ? br.jobs[0] : null;
            await this.prisma.$transaction(async (tx) => {
              if (brJob) {
                await tx.bookingJob.update({
                  where: { id: brJob.id },
                  data: { status: BookingStatus.SUCCESS, leaseExpiresAt: null, completedAt: now },
                });
              }

              if (this.stateMachine) {
                await this.stateMachine.transition({
                  bookingId: br.id,
                  targetStatus: BookingStatus.SUCCESS,
                  targetExecutionStatus: 'COMPLETED',
                  targetFinancialStatus: 'CAPTURED',
                  milestone: 'RECONCILER_CONFIRMED',
                  officialReference: passRef,
                  officialBookingReference: passRef,
                  note: 'Auto-completed by Server Reconciler from authoritative portal reference',
                  force: true,
                }, tx);
              } else {
                await tx.bookingRequest.update({
                  where: { id: br.id },
                  data: {
                    status: BookingStatus.SUCCESS,
                    executionStatus: 'COMPLETED',
                    financialStatus: 'CAPTURED',
                    completedAt: now,
                    assignedMachineId: null,
                    leaseExpiresAt: null,
                  },
                });
              }

              if (this.walletService) {
                const reserveTx = await tx.walletTransaction.findFirst({
                  where: { bookingId: br.id, type: 'RESERVE', status: 'COMPLETED' },
                });
                const feeAmount = reserveTx ? Number(reserveTx.amount) : 10;
                await this.walletService.capture({
                  userId: br.userId,
                  bookingId: br.id,
                  amount: feeAmount,
                  idempotencyKey: `cap_${br.id}`,
                }, tx);
              }
            });

            if (typeof (this.prisma as any).bookingReconciliation?.upsert === 'function') {
              await this.prisma.bookingReconciliation.upsert({
                where: { bookingRequestId: br.id },
                update: {
                  status: 'RECONCILED_SUCCESS',
                  resolvedReference: passRef,
                  resolvedAt: now,
                  investigationNote: 'Auto-reconciled by Reconciler sweep with authoritative pass',
                },
                create: {
                  bookingRequestId: br.id,
                  status: 'RECONCILED_SUCCESS',
                  resolvedReference: passRef,
                  resolvedAt: now,
                  investigationNote: 'Auto-reconciled by Reconciler sweep with authoritative pass',
                },
              }).catch(() => {});
            }

            uncompletedPassesReconciled++;
            details.push(`Auto-completed Booking #${br.bookingCode} with confirmed reference ${passRef}`);
          }
        } catch (recErr: any) {
          this.logger.warn(`Failed to auto-complete booking #${br.bookingCode}: ${recErr.message}. Surfacing in admin queue.`);
          if (typeof (this.prisma as any).bookingReconciliation?.upsert === 'function') {
            await this.prisma.bookingReconciliation.upsert({
              where: { bookingRequestId: br.id },
              update: {
                status: 'PENDING',
                lastMilestone: br.lastMilestone || 'OFFICIAL_PASS_UNCONFIRMED',
                investigationNote: `Official reference ${br.officialBookingReference} detected but auto-completion failed: ${recErr.message}`,
              },
              create: {
                bookingRequestId: br.id,
                status: 'PENDING',
                lastMilestone: br.lastMilestone || 'OFFICIAL_PASS_UNCONFIRMED',
                investigationNote: `Official reference ${br.officialBookingReference} detected but auto-completion failed: ${recErr.message}`,
              },
            }).catch(() => {});
          }
        }
      }
    } catch (passErr: any) {
      this.logger.warn(`Reconcile pending confirmed passes error: ${passErr.message}`);
    }

    // 7b. Surface jobs in RECONCILIATION_REQUIRED or bookings with reconciliationStatus='NEEDS_REVIEW' in admin queue (isolated try/catch)
    try {
      const needsReviewJobs = await this.prisma.bookingJob.findMany({
        where: {
          OR: [
            { status: BookingStatus.RECONCILIATION_REQUIRED },
            { bookingRequest: { reconciliationStatus: 'NEEDS_REVIEW' } },
          ],
        },
        include: { bookingRequest: true },
      });

      for (const nrj of needsReviewJobs) {
        if (nrj.bookingRequestId && typeof (this.prisma as any).bookingReconciliation?.upsert === 'function') {
          await this.prisma.bookingReconciliation.upsert({
            where: { bookingRequestId: nrj.bookingRequestId },
            update: {
              status: 'HUMAN_REVIEW',
              lastMilestone: 'NEEDS_REVIEW',
              investigationNote: nrj.errorMessage || nrj.bookingRequest?.requiresHumanNote || 'Job marked NEEDS_REVIEW after lease mismatch or portal ambiguity.',
            },
            create: {
              bookingRequestId: nrj.bookingRequestId,
              status: 'HUMAN_REVIEW',
              lastMilestone: 'NEEDS_REVIEW',
              investigationNote: nrj.errorMessage || nrj.bookingRequest?.requiresHumanNote || 'Job marked NEEDS_REVIEW after lease mismatch or portal ambiguity.',
            },
          }).catch(() => {});
        }
      }
    } catch (reviewErr: any) {
      this.logger.warn(`Reconcile NEEDS_REVIEW queue error: ${reviewErr.message}`);
    }

    // 7c. Close orphaned non-terminal jobs whose BookingRequest is already terminal (CANCELLED/COMPLETED/SUCCESS/FAILED/EXPIRED)
    let orphanedTerminalJobsClosed = 0;
    try {
      if (typeof this.prisma.bookingJob?.updateMany === 'function') {
        const closedRes = await this.prisma.bookingJob.updateMany({
          where: {
            status: {
              notIn: [BookingStatus.CANCELLED, BookingStatus.SUCCESS, BookingStatus.COMPLETED, BookingStatus.FAILED],
            },
            bookingRequest: {
              status: {
                in: TERMINAL_BOOKING_CLOSURE_STATUSES,
              },
            },
          },
          data: {
            status: BookingStatus.CANCELLED,
            workerId: null,
            leaseExpiresAt: null,
            completedAt: now,
          },
        });
        orphanedTerminalJobsClosed = closedRes?.count ?? 0;
        if (orphanedTerminalJobsClosed > 0) {
          details.push(`Closed ${orphanedTerminalJobsClosed} orphaned job(s) belonging to terminal bookings`);
        }
      }
    } catch (orphanErr: any) {
      this.logger.warn(`Reconcile orphaned terminal jobs error: ${orphanErr.message}`);
    }

    const totalRecovered =
      recoveredCount +
      recreatedJobsCount +
      requeuedAccountsCount +
      retryableRequeuedCount +
      pastBookingsAutoCancelled +
      uncompletedPassesReconciled +
      orphanedTerminalJobsClosed;
    const uncompletedPassesSegment = uncompletedPassesQuerySucceeded
      ? `, Uncompleted Passes: ${uncompletedPassesReconciled}`
      : '';
    this.logger.log(
      `[RECONCILER] Pass completed. Recovered: ${totalRecovered} (Leases: ${recoveredCount}, Recreated: ${recreatedJobsCount}, Accounts: ${requeuedAccountsCount}, Retries: ${retryableRequeuedCount}, Expired Locks: ${expiredLocksCleaned}, Past Bookings Cancelled: ${pastBookingsAutoCancelled}, Orphaned Jobs Closed: ${orphanedTerminalJobsClosed}${uncompletedPassesSegment})`,
    );

    return {
      recoveredCount,
      humanReviewCount,
      totalRecovered,
      staleLeasesRecovered: recoveredCount,
      recreatedJobsCount,
      requeuedAccountsCount,
      retryableRequeuedCount,
      expiredLocksCleaned,
      pastBookingsAutoCancelled,
      ...(uncompletedPassesQuerySucceeded ? { uncompletedPassesReconciled } : {}),
      orphanedTerminalJobsClosed,
      details,
    };
  }

  /**
   * Retrieves allocation history logs with pagination for Admin Fleet UI.
   */
  async getAllocationHistory(params: {
    workerId?: string;
    jobId?: string;
    status?: string;
    limit?: any;
    offset?: any;
  }) {
    const limit = Math.min(parseInt(params.limit || '50', 10), 100);
    const offset = parseInt(params.offset || '0', 10);

    const where: Prisma.JobAllocationLogWhereInput = {};
    if (params.workerId) where.workerId = params.workerId;
    if (params.jobId) where.jobId = params.jobId;
    if (params.status) where.status = params.status;

    const [logs, total] = await Promise.all([
      this.prisma.jobAllocationLog.findMany({
        where,
        include: {
          worker: {
            select: {
              id: true,
              machineCode: true,
              machineName: true,
              deploymentType: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.jobAllocationLog.count({ where }),
    ]);

    return {
      logs,
      total,
      limit,
      offset,
    };
  }

  /**
   * Updates worker capacity and deployment configuration by admin.
   * Supports dynamic monitoring capacity (maxMonitoringRequests) independently of execution concurrency.
   * Gracefully drains if capacity is lowered below active assignments; triggers proactive allocation on upscale.
   */
  async updateWorkerCapacity(
    workerId: string,
    dto: {
      maxConcurrentJobs?: number;
      maxMonitoringRequests?: number;
      deploymentType?: string;
      capabilities?: string[];
      adminStatus?: string;
    },
  ) {
    const worker = await this.prisma.workerMachine.findUnique({
      where: { id: workerId },
    });
    if (!worker) {
      throw new NotFoundException(`Worker machine ${workerId} not found`);
    }

    const currentAssigned = typeof this.prisma.bookingRequest?.count === 'function'
      ? await this.prisma.bookingRequest.count({
          where: {
            assignedMonitoringWorkerId: workerId,
            status: { in: [BookingStatus.PENDING, BookingStatus.WATCHING, BookingStatus.WAITING_FOR_DATE_AVAILABILITY, BookingStatus.FAST_BOOKING_QUEUED] },
          },
        })
      : 0;

    const targetMonitoringCap = dto.maxMonitoringRequests !== undefined ? dto.maxMonitoringRequests : worker.maxMonitoringRequests;
    const isDraining = targetMonitoringCap < currentAssigned;

    const updated = await this.prisma.workerMachine.update({
      where: { id: workerId },
      data: {
        maxConcurrentJobs: dto.maxConcurrentJobs !== undefined ? dto.maxConcurrentJobs : undefined,
        maxMonitoringRequests: dto.maxMonitoringRequests !== undefined ? dto.maxMonitoringRequests : undefined,
        currentAssignedMonitoring: currentAssigned,
        monitoringDraining: isDraining,
        deploymentType: dto.deploymentType || undefined,
        capabilities: dto.capabilities || undefined,
        adminStatus: dto.adminStatus || undefined,
      },
    });

    this.logger.log(
      `Worker ${worker.machineCode} capacity updated: maxConcurrentJobs=${updated.maxConcurrentJobs}, maxMonitoringRequests=${updated.maxMonitoringRequests}, assigned=${currentAssigned}, draining=${isDraining}`,
    );

    // If monitoring capacity was increased, immediately trigger proactive allocation sweep to drain pending queue
    if (dto.maxMonitoringRequests !== undefined && dto.maxMonitoringRequests > worker.maxMonitoringRequests) {
      setImmediate(() => {
        this.runMonitoringAllocationSweep().catch((err) => {
          this.logger.warn(`Post-capacity update monitoring sweep notice: ${err?.message || err}`);
        });
      });
    }

    return updated;
  }

  private isMonitoringSweepRunning = false;

  /**
   * Instantly assign an open/restarted booking to an eligible online worker for availability monitoring.
   * Directly sets status = WATCHING, isWatching = true, and assignedMonitoringWorkerId.
   */
  async assignMonitoringWorkerInstantly(
    bookingId: string,
    tx?: any,
  ): Promise<{ assigned: boolean; worker?: any }> {
    const client = tx || this.prisma;
    const now = new Date();
    const healthyCutoff = new Date(now.getTime() - 35000);

    const booking = await client.bookingRequest.findUnique({
      where: { id: bookingId },
      select: { id: true, bookingCode: true, status: true, version: true, userId: true },
    });
    if (!booking) return { assigned: false };

    // 1. Fetch eligible online workers: Cloud (DOCKER/CLOUD_VM) first, then Local (LOCAL_PC)
    const workers = await client.workerMachine.findMany({
      where: {
        status: { in: [WorkerStatus.ONLINE, WorkerStatus.IDLE, WorkerStatus.BUSY] },
        active: true,
        adminStatus: { notIn: ['REVOKED', 'RETIRED', 'PAUSED', 'DISABLED'] },
        desiredState: 'RUNNING',
        lastHeartbeat: { gte: healthyCutoff },
      },
      orderBy: [
        { deploymentType: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    for (const worker of workers) {
      const isCpuSaturated = Boolean(worker.cpuUsage && worker.cpuUsage > Number(process.env.RESOURCE_THROTTLE_CPU ?? 85));
      const isMemSaturated = Boolean(worker.memoryUsage && worker.memoryUsage > Number(process.env.RESOURCE_THROTTLE_MEM ?? 95));
      const isSoleWorkerWithCapacity = workers.length === 1 && (worker.memoryUsage ?? 0) <= 98 && (worker.cpuUsage ?? 0) <= 95;

      if ((isCpuSaturated || isMemSaturated) && !isSoleWorkerWithCapacity) {
        continue;
      }

      const currentAssigned = await client.bookingRequest.count({
        where: {
          assignedMonitoringWorkerId: worker.id,
          status: { in: [BookingStatus.PENDING, BookingStatus.WATCHING, BookingStatus.WAITING_FOR_DATE_AVAILABILITY, BookingStatus.FAST_BOOKING_QUEUED] },
        },
      });

      const maxCap = worker.maxMonitoringRequests ?? 10;
      if (currentAssigned < maxCap) {
        const leaseExpiry = new Date(now.getTime() + 60000);

        await client.bookingRequest.update({
          where: { id: bookingId },
          data: {
            assignedMonitoringWorkerId: worker.id,
            monitoringAssignedAt: now,
            monitoringLeaseExpiresAt: leaseExpiry,
            status: BookingStatus.WATCHING,
            isWatching: true,
            isManuallyAssigned: false,
          },
        });

        await client.workerMachine.update({
          where: { id: worker.id },
          data: {
            currentAssignedMonitoring: currentAssigned + 1,
          },
        }).catch(() => {});

        this.logger.log(
          `[INSTANT MONITORING ALLOCATION] Booking #${booking.bookingCode} instantly assigned to ${worker.machineCode} (Status: WATCHING, Load: ${currentAssigned + 1}/${maxCap})`
        );

        if (this.eventsGateway) {
          this.eventsGateway.notifyBookingUpdated(booking.id, booking.userId, {
            bookingId: booking.id,
            bookingCode: booking.bookingCode,
            status: BookingStatus.WATCHING,
            assignedMonitoringWorkerId: worker.id,
            monitoringWorker: {
              id: worker.id,
              machineCode: worker.machineCode,
              machineName: worker.machineName,
              status: worker.status,
            },
          });
        }

        return { assigned: true, worker };
      }
    }

    return { assigned: false };
  }

  /**
   * Periodic & Event-Driven Authoritative Monitoring Allocation Engine
   * Allocates unassigned PENDING/WATCHING requests across healthy workers
   * according to their independently configured maxMonitoringRequests.
   * Concurrency-safe: uses row-level locking (FOR UPDATE SKIP LOCKED) within a transaction.
   */
  async runMonitoringAllocationSweep(): Promise<{ allocatedCount: number; pendingCount: number }> {
    if (this.isMonitoringSweepRunning) {
      return { allocatedCount: 0, pendingCount: 0 };
    }
    this.isMonitoringSweepRunning = true;

    try {
      const now = new Date();
      const healthyCutoff = new Date(now.getTime() - 35000); // 35 seconds heartbeat freshness

      // 1. Fetch eligible online workers ordered by priority: Cloud (DOCKER/CLOUD_VM) first, then Local (LOCAL_PC)
      const workers = await this.prisma.workerMachine.findMany({
        where: {
          status: { in: [WorkerStatus.ONLINE, WorkerStatus.IDLE, WorkerStatus.BUSY] },
          active: true,
          adminStatus: { notIn: ['REVOKED', 'RETIRED', 'PAUSED', 'DISABLED'] },
          desiredState: 'RUNNING',
          lastHeartbeat: { gte: healthyCutoff },
        },
        orderBy: [
          { deploymentType: 'asc' }, // CLOUD_VM/DOCKER sorts before LOCAL_PC
          { createdAt: 'asc' },
        ],
      });

      let totalAllocated = 0;

      for (const worker of workers) {
        const isCpuSaturated = Boolean(worker.cpuUsage && worker.cpuUsage > Number(process.env.RESOURCE_THROTTLE_CPU ?? 85));
        const isMemSaturated = Boolean(worker.memoryUsage && worker.memoryUsage > Number(process.env.RESOURCE_THROTTLE_MEM ?? 95));
        const isSoleWorkerWithCapacity = workers.length === 1 && (worker.memoryUsage ?? 0) <= 98 && (worker.cpuUsage ?? 0) <= 95;

        // Resource-aware throttling: skip if CPU or Memory is saturated (> threshold)
        if ((isCpuSaturated || isMemSaturated) && !isSoleWorkerWithCapacity) {
          await this.prisma.workerMachine.update({
            where: { id: worker.id },
            data: { resourceWarning: true },
          }).catch(() => {});
          this.logger.warn(
            `[MONITORING ALLOCATOR] Skipping worker ${worker.machineCode} due to resource saturation (CPU: ${worker.cpuUsage}%, Mem: ${worker.memoryUsage}%)`
          );
          continue;
        } else if (worker.resourceWarning) {
          await this.prisma.workerMachine.update({
            where: { id: worker.id },
            data: { resourceWarning: false },
          }).catch(() => {});
        }

        // Count current active assignments for this worker
        const currentAssigned = await this.prisma.bookingRequest.count({
          where: {
            assignedMonitoringWorkerId: worker.id,
            status: { in: [BookingStatus.PENDING, BookingStatus.WATCHING, BookingStatus.WAITING_FOR_DATE_AVAILABILITY, BookingStatus.FAST_BOOKING_QUEUED] },
          },
        });

        const maxCap = worker.maxMonitoringRequests ?? 10;
        const freeSlots = Math.max(0, maxCap - currentAssigned);
        const isDraining = currentAssigned > maxCap;

        // Keep cached counters in sync
        if (worker.currentAssignedMonitoring !== currentAssigned || worker.monitoringDraining !== isDraining) {
          await this.prisma.workerMachine.update({
            where: { id: worker.id },
            data: {
              currentAssignedMonitoring: currentAssigned,
              monitoringDraining: isDraining,
            },
          }).catch(() => {});
        }

        if (freeSlots <= 0) {
          continue; // Worker is full or draining
        }

        // Concurrency-safe atomic claim using raw SQL row locking (FOR UPDATE SKIP LOCKED)
        const candidates = await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "BookingRequest"
          WHERE "status" IN ('PENDING', 'WATCHING', 'FAST_BOOKING_QUEUED')
            AND "assignedMonitoringWorkerId" IS NULL
            AND COALESCE("isManuallyAssigned", false) = false
          ORDER BY "createdAt" ASC
          LIMIT ${freeSlots}
          FOR UPDATE SKIP LOCKED
        `;

        if (!candidates || candidates.length === 0) {
          continue;
        }

        const candidateIds = candidates.map((c) => c.id);
        const leaseExpiry = new Date(now.getTime() + 60000); // 60s fencing lease

        const updateResult = await this.prisma.bookingRequest.updateMany({
          where: {
            id: { in: candidateIds },
            assignedMonitoringWorkerId: null, // Double CAS barrier
          },
          data: {
            assignedMonitoringWorkerId: worker.id,
            monitoringAssignedAt: now,
            monitoringLeaseExpiresAt: leaseExpiry,
            status: BookingStatus.WATCHING,
            isWatching: true,
          },
        });

        totalAllocated += updateResult.count;

        await this.prisma.workerMachine.update({
          where: { id: worker.id },
          data: {
            currentAssignedMonitoring: currentAssigned + updateResult.count,
          },
        }).catch(() => {});

        this.logger.log(
          `[MONITORING ALLOCATOR] Assigned ${updateResult.count} requests to ${worker.machineCode} (${worker.deploymentType}). New Load: ${currentAssigned + updateResult.count}/${maxCap}`
        );
      }

      // Count unassigned pending monitoring requests in central queue
      const pendingCount = await this.prisma.bookingRequest.count({
        where: {
          status: { in: [BookingStatus.PENDING, BookingStatus.WATCHING, BookingStatus.FAST_BOOKING_QUEUED] },
          assignedMonitoringWorkerId: null,
        },
      });

      return { allocatedCount: totalAllocated, pendingCount };
    } catch (err: any) {
      this.logger.error(`[MONITORING ALLOCATOR] Sweep error: ${err?.message || err}`);
      return { allocatedCount: 0, pendingCount: 0 };
    } finally {
      this.isMonitoringSweepRunning = false;
    }
  }

  /**
   * Safely recovers stale monitoring leases when a worker goes offline or stops sending heartbeats.
   * Does NOT cancel requests; returns them cleanly to central queue for reallocation.
   */
  async recoverStaleMonitoringLeases(): Promise<{ recoveredCount: number }> {
    try {
      const now = new Date();
      const deadCutoff = new Date(now.getTime() - 45000); // 45s offline threshold

      // Find workers that are offline or haven't sent a heartbeat in > 45s
      const deadWorkers = await this.prisma.workerMachine.findMany({
        where: {
          OR: [
            { status: WorkerStatus.OFFLINE },
            { status: WorkerStatus.ERROR },
            { lastHeartbeat: { lt: deadCutoff } },
            { lastHeartbeat: null },
          ],
        },
        select: { id: true, machineCode: true },
      });

      const deadWorkerIds = deadWorkers.map((w) => w.id);

      // Reclaim unpinned requests assigned to dead workers OR with expired lease
      const updateResult = await this.prisma.bookingRequest.updateMany({
        where: {
          isManuallyAssigned: false,
          status: { in: [BookingStatus.PENDING, BookingStatus.WATCHING, BookingStatus.WAITING_FOR_DATE_AVAILABILITY, BookingStatus.FAST_BOOKING_QUEUED] },
          OR: [
            ...(deadWorkerIds.length > 0 ? [{ assignedMonitoringWorkerId: { in: deadWorkerIds } }] : []),
            {
              monitoringLeaseExpiresAt: { lt: now },
              assignedMonitoringWorkerId: { not: null },
            },
          ],
        },
        data: {
          assignedMonitoringWorkerId: null,
          monitoringAssignedAt: null,
          monitoringLeaseExpiresAt: null,
        },
      });

      if (updateResult.count > 0) {
        this.logger.warn(`[MONITORING RECOVERY] Recovered ${updateResult.count} orphaned monitoring requests back to central queue.`);
        // Immediately sweep to assign them to surviving healthy workers
        setImmediate(() => {
          this.runMonitoringAllocationSweep().catch(() => {});
        });
      }

      return { recoveredCount: updateResult.count };
    } catch (err: any) {
      this.logger.error(`[MONITORING RECOVERY] Error recovering stale monitoring leases: ${err?.message || err}`);
      return { recoveredCount: 0 };
    }
  }
}

