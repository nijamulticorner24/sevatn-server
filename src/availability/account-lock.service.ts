import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AccountLockService {
  private readonly logger = new Logger(AccountLockService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Attempts to acquire an exclusive lock for an official account.
   * Prevents simultaneous Playwright executions against the same Sabarimala account.
   * 
   * Idempotent for the SAME booking: if the lock was already acquired for this bookingId
   * (e.g. by SmartMatcher during pre-queueing), it permits safe reuse and associates
   * the claiming workerId while refreshing the TTL.
   * 
   * Strictly excludes DIFFERENT active bookings.
   */
  async acquireLock(
    accountId: string,
    bookingId: string,
    workerId?: string,
    ttlSeconds: number = 300,
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
      const existingLock = await this.prisma.accountLock.findUnique({
        where: { accountId },
      });

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
   * Checks if an account currently has an active lock, optionally excluding a specific booking.
   */
  async isLocked(accountId: string, excludeBookingId?: string): Promise<boolean> {
    if (!accountId) return false;
    const now = new Date();
    const where: any = {
      accountId,
      expiresAt: { gt: now },
    };
    if (excludeBookingId) {
      where.bookingId = { not: excludeBookingId };
    }
    const lock = await this.prisma.accountLock.findFirst({
      where,
    });
    return !!lock;
  }

  /**
   * Cleans up all stale locks
   */
  async cleanupExpiredLocks(): Promise<number> {
    const res = await this.prisma.accountLock.deleteMany({
      where: {
        expiresAt: { lte: new Date() },
      },
    });
    return res.count;
  }
}
