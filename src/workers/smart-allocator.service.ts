import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AccountLockService } from '../availability/account-lock.service';
import { EventsGateway } from '../events/events.gateway';
import { WorkerStatus, BookingStatus, JobType, Prisma } from '@prisma/client';

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
  ) {}

  /**
   * Periodic background task running every 30 seconds to:
   * 1. Safely recover stale/expired worker leases back to queue.
   * 2. Sweep queued pending jobs and assign to eligible idle workers.
   */
  @Interval(30000)
  async handlePeriodicAllocationAndRecovery() {
    try {
      await this.recoverStaleLeases();
      await this.runAllocationSweep();
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

    // 1. Check account lock if linked to an account
    const account = job.account || job.bookingRequest?.account;
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

    try {
      const allocationTx = await this.prisma.$transaction(async (tx) => {
        // Atomic conditional check: verify job is STILL in expected queued status
        const updateCount = await tx.bookingJob.updateMany({
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
            attempt: { increment: 1 },
          },
        });

        if (updateCount.count === 0) {
          throw new ConflictException('Job was concurrently allocated or claimed by another process.');
        }

        // Update BookingRequest if applicable
        if (job.bookingRequestId) {
          await tx.bookingRequest.update({
            where: { id: job.bookingRequestId },
            data: {
              assignedMachineId: selected.id,
              leaseStartedAt: now,
              leaseExpiresAt: leaseExpiry,
              status: BookingStatus.EXECUTING,
            },
          });
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

    // Priority 2: Oldest pending Booking Execution
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
      },
      orderBy: { createdAt: 'asc' },
    });

    if (nextBooking) {
      return this.allocateJob(nextBooking.id);
    }

    return null;
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
   * Reconciles authoritative capacity counters by checking active database leases.
   */
  async reconcileWorkerCapacity(workerId: string): Promise<number> {
    const activeJobCount = await this.prisma.bookingJob.count({
      where: {
        workerId,
        status: {
          in: [
            BookingStatus.WORKER_ASSIGNED,
            BookingStatus.EXECUTING,
            BookingStatus.CHECKING_AVAILABILITY,
            BookingStatus.WATCHING,
          ],
        },
      },
    });

    await this.prisma.workerMachine.update({
      where: { id: workerId },
      data: {
        currentActiveJobs: activeJobCount,
        status: activeJobCount > 0 ? WorkerStatus.BUSY : WorkerStatus.ONLINE,
      },
    });

    return activeJobCount;
  }

  /**
   * Recovers expired worker reservations with strict safety controls.
   * If outcome is ambiguous or external site submission occurred, flags for human review.
   */
  async recoverStaleLeases(): Promise<{ recoveredCount: number; humanReviewCount: number }> {
    const now = new Date();
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

    let recoveredCount = 0;
    let humanReviewCount = 0;

    for (const job of expiredJobs) {
      try {
        const assignedWorkerId = job.workerId;

        // Safety: If job reached site submission or verification, external booking could exist
        const isAmbiguous =
          job.status === BookingStatus.EXECUTING &&
          job.bookingRequest?.officialReference === null &&
          (job.attempt || 0) > 1;

        if (isAmbiguous) {
          // Escalate to human review to prevent duplicate portal booking
          await this.prisma.bookingJob.update({
            where: { id: job.id },
            data: {
              status: BookingStatus.REQUIRES_HUMAN,
              errorMessage: 'Worker lease expired during active execution. Ambiguous portal state requires verification.',
            },
          });

          if (job.bookingRequestId) {
            await this.prisma.bookingRequest.update({
              where: { id: job.bookingRequestId },
              data: {
                status: BookingStatus.REQUIRES_HUMAN,
                requiresHumanNote: 'Worker lease expired during execution. Check Sabarimala portal before retrying.',
              },
            });
          }

          humanReviewCount++;
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

          recoveredCount++;
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

    return { recoveredCount, humanReviewCount };
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
   */
  async updateWorkerCapacity(
    workerId: string,
    dto: {
      maxConcurrentJobs?: number;
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

    const updated = await this.prisma.workerMachine.update({
      where: { id: workerId },
      data: {
        maxConcurrentJobs: dto.maxConcurrentJobs !== undefined ? dto.maxConcurrentJobs : undefined,
        deploymentType: dto.deploymentType || undefined,
        capabilities: dto.capabilities || undefined,
        adminStatus: dto.adminStatus || undefined,
      },
    });

    this.logger.log(
      `Worker ${worker.machineCode} capacity updated: max=${updated.maxConcurrentJobs}, deployment=${updated.deploymentType}`,
    );

    return updated;
  }
}

