import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SmartMatcherService, AvailabilityEventPayload, MatchResult } from './smart-matcher.service';
import { AccountLockService } from './account-lock.service';
import { BookingStatus } from '@prisma/client';
import { Interval } from '@nestjs/schedule';

export interface DateDemandGroup {
  date: string; // YYYY-MM-DD
  route: string;
  pendingCount: number;
}

@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private prisma: PrismaService,
    private smartMatcher: SmartMatcherService,
    private accountLockService: AccountLockService,
  ) {}

  /**
   * Retrieves the Date Demand Index: all dates and routes with active pending bookings.
   * This is used by the Availability Discovery workers to know which dates to inspect.
   */
  async getDemandDates(): Promise<DateDemandGroup[]> {
    const pendingBookings = await this.prisma.bookingRequest.findMany({
      where: {
        status: {
          in: [
            BookingStatus.PENDING,
            BookingStatus.QUEUED,
            BookingStatus.TEMPORARY_SLOT_LOST,
            BookingStatus.WAITING_FOR_ACCOUNT,
          ],
        },
      },
      select: {
        requestedDate: true,
        requestedDateStr: true,
        route: true,
      },
    });

    const map = new Map<string, DateDemandGroup>();

    for (const b of pendingBookings) {
      const dateStr = b.requestedDateStr || b.requestedDate.toISOString().split('T')[0];
      const key = `${dateStr}|${b.route}`;
      const existing = map.get(key);
      if (existing) {
        existing.pendingCount++;
      } else {
        map.set(key, {
          date: dateStr,
          route: b.route,
          pendingCount: 1,
        });
      }
    }

    const demandGroups = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
    this.logger.log(`[AVAILABILITY] Active demand groups: ${demandGroups.map((g) => `${g.date} (${g.pendingCount})`).join(', ') || 'None'}`);
    return demandGroups;
  }

  /**
   * Handles incoming availability detection from an Availability Discovery worker.
   */
  async publishAvailability(event: AvailabilityEventPayload): Promise<MatchResult> {
    this.logger.log(`[AVAILABILITY] Event received: ${event.date} / ${event.route} / ${event.timeSlot}`);
    return await this.smartMatcher.matchAvailabilityEvent(event);
  }

  /**
   * Handles bulk availability discovery results (when multiple dates/slots are discovered at once).
   */
  async publishBulkAvailability(events: AvailabilityEventPayload[]): Promise<MatchResult[]> {
    const results: MatchResult[] = [];
    for (const ev of events) {
      const res = await this.smartMatcher.matchAvailabilityEvent(ev);
      results.push(res);
    }
    return results;
  }

  /**
   * Periodic background reconciliation and lock cleanup (runs every 15 seconds)
   */
  @Interval(15000)
  async handleReconciliationSweep() {
    // 1. Clean expired account locks
    const expiredLocksCount = await this.accountLockService.cleanupExpiredLocks();
    if (expiredLocksCount > 0) {
      this.logger.log(`[RECONCILIATION] Cleaned ${expiredLocksCount} expired account lock(s)`);
    }

    // 2. Retry WAITING_FOR_ACCOUNT bookings if their account has become free
    const waitingBookings = await this.prisma.bookingRequest.findMany({
      where: { status: BookingStatus.WAITING_FOR_ACCOUNT },
      take: 10,
      orderBy: { createdAt: 'asc' },
    });

    for (const b of waitingBookings) {
      if (b.accountId) {
        const isLocked = await this.accountLockService.isLocked(b.accountId);
        if (!isLocked) {
          this.logger.log(`[RECONCILIATION] Account for Booking #${b.bookingCode} is now free. Returning to PENDING state.`);
          await this.prisma.bookingRequest.update({
            where: { id: b.id },
            data: { status: BookingStatus.PENDING },
          });
        }
      }
    }
  }

  /**
   * Returns discovered opportunities history for admin observability
   */
  async getRecentOpportunities(limit: number = 50) {
    return this.prisma.availabilityOpportunity.findMany({
      take: limit,
      orderBy: { detectedAt: 'desc' },
    });
  }
}
