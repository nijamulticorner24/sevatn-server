import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AccountLockService {
  private readonly logger = new Logger(AccountLockService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Attempts to acquire an exclusive lock for an official account.
   * Prevents simultaneous Playwright executions against the same Sabarimala account.
   */
  async acquireLock(
    accountId: string,
    bookingId: string,
    workerId?: string,
    ttlSeconds: number = 300,
  ): Promise<boolean> {
    if (!accountId) return true; // Anonymous/no-account bookings don't collide

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    try {
      // Clean expired lock for this account if any
      await this.prisma.accountLock.deleteMany({
        where: {
          accountId,
          expiresAt: { lte: now },
        },
      });

      // Try inserting lock atomically
      await this.prisma.accountLock.create({
        data: {
          accountId,
          bookingId,
          workerId,
          lockedAt: now,
          expiresAt,
        },
      });

      this.logger.log(`[ACCOUNT_LOCK] Acquired lock for account ${accountId} (Booking: ${bookingId})`);
      return true;
    } catch (err: any) {
      // Unique constraint violation means another execution holds the lock
      this.logger.warn(`[ACCOUNT_LOCK] Account ${accountId} is locked by another active booking.`);
      return false;
    }
  }

  /**
   * Releases the lock when execution finishes or fails
   */
  async releaseLock(accountId?: string | null, bookingId?: string) {
    if (!accountId) return;

    try {
      const where: any = { accountId };
      if (bookingId) {
        where.bookingId = bookingId;
      }
      await this.prisma.accountLock.deleteMany({ where });
      this.logger.log(`[ACCOUNT_LOCK] Released lock for account ${accountId}`);
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
   * Checks if an account currently has an active lock
   */
  async isLocked(accountId: string): Promise<boolean> {
    if (!accountId) return false;
    const now = new Date();
    const lock = await this.prisma.accountLock.findFirst({
      where: {
        accountId,
        expiresAt: { gt: now },
      },
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
