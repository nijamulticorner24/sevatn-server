import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ACTIVE_RUNNING_JOB_STATUSES,
  extractAuthoritativeReference,
} from '../common/booking-status.constants';

const ACCOUNT_LOCK_TERMINAL_STATUSES: string[] = [
  'CANCELLED',
  'FAILED',
  'COMPLETED',
  'SUCCESS',
  'BOOKING_CONFIRMED',
  'HOLD_INVALID_NOMINEE',
  'RETRYABLE_FAILURE',
  'EXPIRED',
  'WATCHING',
];

@Injectable()
export class AccountLockService {
  private readonly logger = new Logger(AccountLockService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Inspects whether an existing account lock is held by a finished, completed,
   * reference-bearing, or lease-expired stale job/booking so it can be safely reclaimed.
   */
  private async inspectLockFreshness(
    lock: { accountId: string; bookingId: string; workerId?: string | null; expiresAt: Date },
    now: Date,
  ): Promise<{ stale: boolean; reason?: string; holdingJobId?: string }> {
    if (lock.expiresAt <= now) {
      return { stale: true, reason: 'LOCK_TTL_EXPIRED' };
    }

    if (typeof this.prisma.bookingRequest?.findUnique !== 'function') {
      return { stale: false };
    }

    let holdingBooking: any = null;
    try {
      holdingBooking = await this.prisma.bookingRequest.findUnique({
        where: { id: lock.bookingId },
        select: {
          id: true,
          status: true,
          assignedMachineId: true,
          leaseExpiresAt: true,
          officialBookingReference: true,
          officialReference: true,
          cartId: true,
          reconciliationStatus: true,
          jobs: {
            select: {
              id: true,
              status: true,
              workerId: true,
              leaseExpiresAt: true,
            },
          },
        },
      });
    } catch {
      // Fallback for unit-test mocks that don't support nested select
      holdingBooking = await this.prisma.bookingRequest.findUnique({
        where: { id: lock.bookingId },
      }).catch(() => null);
    }

    if (!holdingBooking) {
      return { stale: true, reason: 'HOLDING_BOOKING_MISSING' };
    }

    if (ACCOUNT_LOCK_TERMINAL_STATUSES.includes(holdingBooking.status as any)) {
      return { stale: true, reason: `HOLDING_BOOKING_TERMINAL(${holdingBooking.status})` };
    }

    const officialRef = extractAuthoritativeReference(holdingBooking);
    if (officialRef) {
      return { stale: true, reason: `HOLDING_BOOKING_ALREADY_HAS_REF(${officialRef})` };
    }

    // Check associated jobs (if loaded) to ensure finished or lease-expired jobs never hold the lock
    const jobs: any[] = Array.isArray(holdingBooking.jobs) ? holdingBooking.jobs : [];
    const primaryJob = jobs[0];

    if (jobs.length > 0) {
      const hasLiveRunningOrQueuedJob = jobs.some((j) => {
        const jStatus = j.status as any;
        if (ACCOUNT_LOCK_TERMINAL_STATUSES.includes(jStatus) || jStatus === 'NEEDS_REVIEW') {
          return false;
        }
        // Queued job freshly placed by SmartMatcher (no workerId yet, lock TTL unexpired) is still valid
        if (jStatus === 'QUEUED' && !j.workerId) {
          return true;
        }
        // Running job must have an unexpired lease
        if (ACTIVE_RUNNING_JOB_STATUSES.includes(jStatus)) {
          return !!(j.leaseExpiresAt && new Date(j.leaseExpiresAt).getTime() > now.getTime());
        }
        return false;
      });

      if (!hasLiveRunningOrQueuedJob) {
        return {
          stale: true,
          reason: `HOLDING_JOB_STALE_OR_FINISHED(job=${primaryJob?.id || 'unknown'}, status=${primaryJob?.status || 'unknown'})`,
          holdingJobId: primaryJob?.id,
        };
      }
    } else if (
      holdingBooking.leaseExpiresAt &&
      new Date(holdingBooking.leaseExpiresAt).getTime() <= now.getTime()
    ) {
      return { stale: true, reason: 'HOLDING_BOOKING_LEASE_EXPIRED' };
    }

    return { stale: false, holdingJobId: primaryJob?.id };
  }

  /**
   * Attempts to acquire an exclusive lock for an official account.
   * Prevents simultaneous Playwright executions against the same Sabarimala account.
   * 
   * Idempotent for the SAME booking: if the lock was already acquired for this bookingId
   * (e.g. by SmartMatcher during pre-queueing), it permits safe reuse and associates
   * the claiming workerId while refreshing the TTL.
   * 
   * Strictly excludes DIFFERENT active bookings, while automatically reclaiming locks
   * held by finished or stale/lease-expired jobs.
   */
  async acquireLock(
    accountId: string,
    bookingId: string,
    workerId?: string,
    ttlSeconds: number = Number(process.env.ACCOUNT_LOCK_TTL_SEC || 60),
    leaseGeneration?: number,
  ): Promise<boolean> {
    if (!accountId) return true; // Anonymous/no-account bookings don't collide

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const gen = leaseGeneration !== undefined ? leaseGeneration : 1;

    try {
      // 1. Clean expired lock for this account if any
      await this.prisma.accountLock.deleteMany({
        where: {
          accountId,
          expiresAt: { lte: now },
        },
      });

      // 2. Inspect existing lock for this account
      let existingLock = await this.prisma.accountLock.findUnique({
        where: { accountId },
      });

      // 2b. Never hold a lock for a finished or stale/expired job:
      if (existingLock && existingLock.bookingId !== bookingId) {
        const freshness = await this.inspectLockFreshness(existingLock, now);
        if (freshness.stale) {
          this.logger.log(
            `[ACCOUNT_LOCK] Reclaiming stale/finished lock for account ${accountId}: holding booking #${existingLock.bookingId} (${freshness.reason}).`,
          );
          await this.prisma.accountLock.deleteMany({ where: { accountId } }).catch(() => {});
          existingLock = null;
        }
      }

      if (!existingLock) {
        // No lock exists -> Try inserting lock atomically
        try {
          await (this.prisma as any).accountLock.create({
            data: {
              accountId,
              bookingId,
              workerId,
              leaseGeneration: gen,
              lockedAt: now,
              expiresAt,
            },
          });

          this.logger.log(`[ACCOUNT_LOCK] Acquired new lock for account ${accountId} (Booking: ${bookingId}, Gen: ${gen})`);
          return true;
        } catch (err: any) {
          // Race condition: another process inserted just before us
          const raceLock: any = await this.prisma.accountLock.findUnique({
            where: { accountId },
          });

          if (raceLock && raceLock.bookingId === bookingId && raceLock.expiresAt > now) {
            if ((workerId && raceLock.workerId !== workerId) || (leaseGeneration !== undefined && raceLock.leaseGeneration < gen)) {
              await (this.prisma as any).accountLock.update({
                where: { accountId },
                data: { workerId, expiresAt, leaseGeneration: gen },
              });
            }
            this.logger.log(`[ACCOUNT_LOCK] Reused lock following race condition for account ${accountId} (Booking: ${bookingId})`);
            return true;
          }

          this.logger.warn(`[ACCOUNT_LOCK] Account ${accountId} is locked by another active booking (${raceLock?.bookingId || 'unknown'}).`);
          return false;
        }
      }

      // 3. Existing lock is present. Check ownership:
      if (existingLock.bookingId === bookingId) {
        // Same booking: permit safe lock reuse
        if (workerId && existingLock.workerId !== workerId) {
          await this.prisma.accountLock.update({
            where: { accountId },
            data: {
              workerId,
              expiresAt, // Refresh TTL for the claiming worker
            },
          });
          this.logger.log(`[ACCOUNT_LOCK] Reused and updated lock for account ${accountId} with worker ${workerId} (Booking: ${bookingId})`);
        } else if (existingLock.expiresAt < expiresAt) {
          await this.prisma.accountLock.update({
            where: { accountId },
            data: { expiresAt },
          });
          this.logger.log(`[ACCOUNT_LOCK] Reused and refreshed lock TTL for account ${accountId} (Booking: ${bookingId})`);
        } else {
          this.logger.log(`[ACCOUNT_LOCK] Reused existing lock for account ${accountId} (Booking: ${bookingId})`);
        }
        return true;
      }

      // 4. Existing lock belongs to a DIFFERENT booking. Is it expired?
      if (existingLock.expiresAt <= now) {
        const reclaimResult = await this.prisma.accountLock.updateMany({
          where: {
            accountId,
            expiresAt: { lte: now },
          },
          data: {
            bookingId,
            workerId: workerId || null,
            lockedAt: now,
            expiresAt,
          },
        });
        if (reclaimResult.count > 0) {
          this.logger.log(`[ACCOUNT_LOCK] Reclaimed expired lock for account ${accountId} (Booking: ${bookingId})`);
          return true;
        }
        return false;
      }

      // 5. Existing lock belongs to a different unexpired booking -> reject claim
      this.logger.warn(`[ACCOUNT_LOCK] Account ${accountId} is locked by another active booking (${existingLock.bookingId}).`);
      return false;
    } catch (err: any) {
      this.logger.error(`[ACCOUNT_LOCK] Unexpected error acquiring lock for account ${accountId}: ${err.message}`, err.stack);
      return false;
    }
  }

  /**
   * Releases the lock when execution finishes or fails.
   * If leaseGeneration is provided, guards against stale workers releasing locks acquired by newer lease generations.
   * Uses exact generation equality to prevent ABA lock deletion.
   */
  async releaseLock(accountId?: string | null, bookingId?: string, leaseGeneration?: number) {
    if (!accountId) return;

    try {
      const where: any = { accountId };
      if (bookingId) {
        where.bookingId = bookingId;
      }
      if (leaseGeneration !== undefined) {
        where.leaseGeneration = leaseGeneration;
      }
      const res = await this.prisma.accountLock.deleteMany({ where });
      if (res.count > 0) {
        this.logger.log(`[ACCOUNT_LOCK] Released lock for account ${accountId} (Booking: ${bookingId || 'any'}, Gen: ${leaseGeneration ?? 'unfenced'})`);
      } else {
        this.logger.log(`[ACCOUNT_LOCK] No active matching lock to release for account ${accountId} (stale generation or already freed)`);
      }
    } catch (err: any) {
      this.logger.warn(`[ACCOUNT_LOCK] Error releasing lock for account ${accountId}: ${err.message}`);
    }
  }

  /**
   * Releases all locks held by a specific worker machine
   */
  async releaseLockByWorker(workerId: string) {
    if (!workerId) return;
    try {
      const res = await this.prisma.accountLock.deleteMany({ where: { workerId } });
      if (res.count > 0) {
        this.logger.log(`[ACCOUNT_LOCK] Released ${res.count} lock(s) held by worker ${workerId}`);
      }
    } catch (err: any) {
      this.logger.warn(`[ACCOUNT_LOCK] Error releasing locks for worker ${workerId}: ${err.message}`);
    }
  }

  /**
   * Returns active lock holder info (reclaiming stale/finished locks automatically).
   */
  async getActiveLockHolder(
    accountId: string,
    excludeBookingId?: string,
  ): Promise<{ locked: boolean; bookingId?: string; jobId?: string; workerId?: string }> {
    if (!accountId) return { locked: false };
    const now = new Date();
    const where: any = { accountId };
    if (excludeBookingId) {
      where.bookingId = { not: excludeBookingId };
    }
    const lock = await this.prisma.accountLock.findFirst({ where });
    if (!lock) return { locked: false };

    const freshness = await this.inspectLockFreshness(lock, now);
    if (freshness.stale) {
      this.logger.log(
        `[ACCOUNT_LOCK] Reclaiming stale/finished lock for account ${accountId}: holding booking #${lock.bookingId} (${freshness.reason}).`,
      );
      await this.prisma.accountLock.deleteMany({ where: { accountId, bookingId: lock.bookingId } }).catch(() => {});
      return { locked: false };
    }

    return {
      locked: true,
      bookingId: lock.bookingId,
      jobId: freshness.holdingJobId || lock.bookingId,
      workerId: lock.workerId || undefined,
    };
  }

  /**
   * Checks if an account currently has an active lock, optionally excluding a specific booking.
   */
  async isLocked(accountId: string, excludeBookingId?: string): Promise<boolean> {
    const holder = await this.getActiveLockHolder(accountId, excludeBookingId);
    return holder.locked;
  }

  /**
   * Cleans up all stale locks (expired TTL, terminal bookings, finished or lease-expired jobs)
   */
  async cleanupExpiredLocks(): Promise<number> {
    const now = new Date();
    const res = await this.prisma.accountLock.deleteMany({
      where: {
        expiresAt: { lte: now },
      },
    });

    let reclaimedOrphans = 0;
    try {
      if (typeof this.prisma.accountLock?.findMany === 'function') {
        const activeLocks = await this.prisma.accountLock.findMany();
        for (const al of activeLocks) {
          const freshness = await this.inspectLockFreshness(al, now);
          if (freshness.stale) {
            this.logger.log(
              `[ACCOUNT_LOCK] Cleanup reclaimed stale lock for account ${al.accountId} (booking=${al.bookingId}, reason=${freshness.reason}).`,
            );
            await this.prisma.accountLock.deleteMany({ where: { accountId: al.accountId, bookingId: al.bookingId } }).catch(() => {});
            reclaimedOrphans++;
          }
        }
      }
    } catch (_) {}

    return res.count + reclaimedOrphans;
  }
}
