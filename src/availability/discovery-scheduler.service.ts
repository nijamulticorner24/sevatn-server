import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeDemandKey } from '../common/utils/demand-key';

export interface DiscoveryMetrics {
  scansTotal: number;
  duplicateScansPrevented: number;
  activeDiscoveryLocks: number;
  discoveryDurationTotalMs: number;
  portalErrorsTotal: number;
  eligibleBookingsMatched: number;
  executionJobsCreated: number;
  browserLaunchesSaved: number;
}

@Injectable()
export class DiscoverySchedulerService {
  private readonly logger = new Logger(DiscoverySchedulerService.name);

  // Configurable scheduling intervals (ms)
  readonly availableIntervalMs: number;
  readonly unavailableIntervalMs: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly lockTtlMs: number;

  // In-memory runtime telemetry metrics
  private metrics: DiscoveryMetrics = {
    scansTotal: 0,
    duplicateScansPrevented: 0,
    activeDiscoveryLocks: 0,
    discoveryDurationTotalMs: 0,
    portalErrorsTotal: 0,
    eligibleBookingsMatched: 0,
    executionJobsCreated: 0,
    browserLaunchesSaved: 0,
  };

  constructor(private prisma: PrismaService) {
    this.availableIntervalMs = parseInt(
      process.env.AVAILABILITY_DISCOVERY_AVAILABLE_INTERVAL_MS || '60000',
      10,
    );
    this.unavailableIntervalMs = parseInt(
      process.env.AVAILABILITY_DISCOVERY_UNAVAILABLE_INTERVAL_MS || '30000',
      10,
    );
    this.baseBackoffMs = parseInt(
      process.env.AVAILABILITY_DISCOVERY_BACKOFF_MS || '15000',
      10,
    );
    this.maxBackoffMs = parseInt(
      process.env.AVAILABILITY_DISCOVERY_MAX_BACKOFF_MS || '300000',
      10,
    );
    this.lockTtlMs = parseInt(
      process.env.AVAILABILITY_DISCOVERY_LOCK_TTL_MS || '45000',
      10,
    );
  }

  /**
   * Retrieves or initializes a discovery schedule record for a normalized demand key.
   */
  async ensureSchedule(date: string, route: string, criteria?: string) {
    const demandKey = normalizeDemandKey(date, route, criteria);
    const existing = await this.prisma.discoverySchedule.findUnique({
      where: { demandKey },
    });

    if (existing) {
      return existing;
    }

    // New demand or changed demand: allow immediate discovery
    return await this.prisma.discoverySchedule.create({
      data: {
        demandKey,
        date,
        route,
        status: 'UNKNOWN',
        nextCheckAt: new Date(Date.now() - 1000), // Immediate due
      },
    });
  }

  /**
   * Distributed atomic claim for a demand discovery scan.
   * Enforces:
   * 1. nextCheckAt <= NOW()
   * 2. Not currently locked by another worker (or lock has expired)
   */
  async claimDemandScan(demandKey: string, workerId: string): Promise<{ claimed: boolean; message?: string }> {
    const now = new Date();
    const lockExpiry = new Date(now.getTime() + this.lockTtlMs);

    // Atomic CAS update
    const updateResult = await this.prisma.discoverySchedule.updateMany({
      where: {
        demandKey,
        nextCheckAt: { lte: now },
        OR: [
          { lockedBy: null },
          { lockExpiresAt: { lte: now } },
          { lockedBy: workerId },
        ],
      },
      data: {
        lockedBy: workerId,
        lockedAt: now,
        lockExpiresAt: lockExpiry,
      },
    });

    if (updateResult.count > 0) {
      this.metrics.scansTotal++;
      this.metrics.activeDiscoveryLocks++;
      this.logger.log(`[DISCOVERY] demandKey=${demandKey} claim=ACQUIRED workerId=${workerId} lockExpiresAt=${lockExpiry.toISOString()}`);
      return { claimed: true };
    }

    // Inspect reason for skip
    const schedule = await this.prisma.discoverySchedule.findUnique({
      where: { demandKey },
    });

    this.metrics.duplicateScansPrevented++;
    if (schedule && schedule.nextCheckAt > now) {
      this.logger.log(
        `[DISCOVERY] demandKey=${demandKey} lastCheckedAt=${schedule.lastCheckedAt?.toISOString() || 'NEVER'} nextCheckAt=${schedule.nextCheckAt.toISOString()} deduplication=SKIPPED reason=INTERVAL_THROTTLED`,
      );
      return { claimed: false, message: 'INTERVAL_THROTTLED' };
    }

    if (schedule && schedule.lockedBy && schedule.lockExpiresAt && schedule.lockExpiresAt > now) {
      this.logger.log(
        `[DISCOVERY] demandKey=${demandKey} lockedBy=${schedule.lockedBy} lockExpiresAt=${schedule.lockExpiresAt.toISOString()} deduplication=SKIPPED reason=IN_FLIGHT_BY_ANOTHER_WORKER`,
      );
      return { claimed: false, message: 'IN_FLIGHT_BY_ANOTHER_WORKER' };
    }

    return { claimed: false, message: 'NOT_DUE' };
  }

  /**
   * Distributed ownership-checked release of a demand discovery scan.
   * Updates lastCheckedAt, calculates nextCheckAt based on policy, and clears lock.
   */
  async releaseDemandScan(
    demandKey: string,
    workerId: string,
    status: 'AVAILABLE' | 'UNAVAILABLE' | 'ERROR',
    durationMs?: number,
  ) {
    const now = new Date();
    const schedule = await this.prisma.discoverySchedule.findUnique({
      where: { demandKey },
    });

    if (!schedule) {
      this.logger.warn(`[DISCOVERY] releaseDemandScan: Schedule for ${demandKey} not found.`);
      return;
    }

    // Verify ownership or expired lock
    const isOwner = schedule.lockedBy === workerId;
    const isLockExpired = schedule.lockExpiresAt ? schedule.lockExpiresAt <= now : true;
    if (!isOwner && !isLockExpired) {
      this.logger.warn(
        `[DISCOVERY] demandKey=${demandKey} lock release rejected: owned by ${schedule.lockedBy}, release requested by ${workerId}`,
      );
      return;
    }

    let nextDelayMs: number;
    let newConsecutiveErrors = schedule.consecutiveErrors;

    if (status === 'AVAILABLE') {
      nextDelayMs = this.availableIntervalMs; // 60s default
      newConsecutiveErrors = 0;
    } else if (status === 'UNAVAILABLE') {
      nextDelayMs = this.unavailableIntervalMs; // 30s default
      newConsecutiveErrors = 0;
    } else {
      // ERROR: Exponential backoff
      this.metrics.portalErrorsTotal++;
      newConsecutiveErrors = schedule.consecutiveErrors + 1;
      const exponentialMultiplier = Math.pow(2, Math.min(newConsecutiveErrors - 1, 5));
      nextDelayMs = Math.min(this.baseBackoffMs * exponentialMultiplier, this.maxBackoffMs);
    }

    const nextCheckAt = new Date(now.getTime() + nextDelayMs);

    await this.prisma.discoverySchedule.updateMany({
      where: {
        demandKey,
        OR: [{ lockedBy: workerId }, { lockExpiresAt: { lte: now } }],
      },
      data: {
        lockedBy: null,
        lockedAt: null,
        lockExpiresAt: null,
        lastCheckedAt: now,
        nextCheckAt,
        status,
        consecutiveErrors: newConsecutiveErrors,
      },
    });

    if (this.metrics.activeDiscoveryLocks > 0) {
      this.metrics.activeDiscoveryLocks--;
    }
    if (durationMs) {
      this.metrics.discoveryDurationTotalMs += durationMs;
    }

    this.logger.log(
      `[DISCOVERY] demandKey=${demandKey} result=${status} lastCheckedAt=${now.toISOString()} nextCheckAt=${nextCheckAt.toISOString()} delayMs=${nextDelayMs}`,
    );
  }

  recordBrowserLaunchSaved(count: number = 1) {
    this.metrics.browserLaunchesSaved += count;
  }

  recordJobCreated(count: number = 1) {
    this.metrics.executionJobsCreated += count;
  }

  recordBookingsMatched(count: number = 1) {
    this.metrics.eligibleBookingsMatched += count;
  }

  getMetrics(): DiscoveryMetrics {
    return { ...this.metrics };
  }
}
