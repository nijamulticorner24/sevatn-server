import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SmartMatcherService, AvailabilityEventPayload, MatchResult } from './smart-matcher.service';
import { AccountLockService } from './account-lock.service';
import { DiscoverySchedulerService } from './discovery-scheduler.service';
import { BookingStateMachineService } from '../bookings/booking-state-machine.service';
import { BookingStatus } from '@prisma/client';
import { Interval } from '@nestjs/schedule';
import { normalizeDemandKey } from '../common/utils/demand-key';

export interface DateDemandGroup {
  demandKey: string;
  date: string; // YYYY-MM-DD
  route: string;
  pendingCount: number;
  isDue: boolean;
  status: string;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  lockedBy?: string | null;
}

@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private prisma: PrismaService,
    private smartMatcher: SmartMatcherService,
    private accountLockService: AccountLockService,
    private discoveryScheduler: DiscoverySchedulerService,
    @Optional() private stateMachine?: BookingStateMachineService,
  ) {}

  /**
   * Retrieves the Date Demand Index: all dates and routes with active pending bookings.
   * This is used by the Availability Discovery workers to know which dates to inspect.
   * Integrates with DiscoverySchedule to provide intelligent throttling and distributed status.
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

    const now = new Date();
    const map = new Map<string, { date: string; route: string; pendingCount: number }>();

    for (const b of pendingBookings) {
      const dateStr = b.requestedDateStr || (b.requestedDate instanceof Date ? b.requestedDate.toISOString().split('T')[0] : String(b.requestedDate).split('T')[0]);
      const key = normalizeDemandKey(dateStr, b.route);
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

    const demandGroups: DateDemandGroup[] = [];

    for (const [demandKey, group] of map.entries()) {
      const schedule = await this.discoveryScheduler.ensureSchedule(group.date, group.route);
      const currentTime = new Date();
      const isLockExpired = schedule.lockExpiresAt ? schedule.lockExpiresAt <= currentTime : true;
      const isDue = (!schedule.lockedBy || isLockExpired) && schedule.nextCheckAt <= currentTime;

      demandGroups.push({
        demandKey,
        date: group.date,
        route: group.route,
        pendingCount: group.pendingCount,
        isDue,
        status: schedule.status,
        lastCheckedAt: schedule.lastCheckedAt ? schedule.lastCheckedAt.toISOString() : null,
        nextCheckAt: schedule.nextCheckAt ? schedule.nextCheckAt.toISOString() : null,
        lockedBy: schedule.lockedBy,
      });
    }

    demandGroups.sort((a, b) => a.date.localeCompare(b.date));
    this.logger.log(
      `[AVAILABILITY] Active demand groups: ${demandGroups.map((g) => `${g.demandKey} (pending: ${g.pendingCount}, due: ${g.isDue}, status: ${g.status})`).join(', ') || 'None'}`,
    );
    return demandGroups;
  }

  /**
   * Distributed atomic claim for a demand discovery scan.
   */
  async claimDemandScan(demandKey: string, workerId: string) {
    return await this.discoveryScheduler.claimDemandScan(demandKey, workerId);
  }

  /**
   * Distributed release of a demand discovery scan with interval policy update.
   */
  async releaseDemandScan(
    demandKey: string,
    workerId: string,
    status: 'AVAILABLE' | 'UNAVAILABLE' | 'ERROR',
    durationMs?: number,
  ) {
    return await this.discoveryScheduler.releaseDemandScan(demandKey, workerId, status, durationMs);
  }

  /**
   * Runtime discovery metrics for monitoring & observability.
   */
  getDiscoveryMetrics() {
    return this.discoveryScheduler.getMetrics();
  }

  /**
   * Handles incoming availability detection from an Availability Discovery worker.
   */
  async publishAvailability(event: AvailabilityEventPayload): Promise<MatchResult> {
    const demandKey = normalizeDemandKey(event.date, event.route);
    this.logger.log(`[DISCOVERY] Event received for demandKey=${demandKey}: ${event.date} / ${event.route}${event.timeSlot ? ` / ${event.timeSlot}` : ''}`);
    const result = await this.smartMatcher.matchAvailabilityEvent(event);
    if (result.matched) {
      this.discoveryScheduler.recordBookingsMatched(1);
      this.discoveryScheduler.recordJobCreated(1);
    }
    return result;
  }

  /**
   * Handles bulk availability discovery results (when multiple dates/slots are discovered at once).
   */
  async publishBulkAvailability(events: AvailabilityEventPayload[]): Promise<MatchResult[]> {
    const results: MatchResult[] = [];
    for (const ev of events) {
      const res = await this.publishAvailability(ev);
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
          if (this.stateMachine) {
            try {
              await this.stateMachine.transition({
                bookingId: b.id,
                targetStatus: BookingStatus.PENDING,
                milestone: 'ACCOUNT_FREED_RETURNED_TO_PENDING',
              });
            } catch (smErr: any) {
              this.logger.warn(`State machine transition failed for #${b.id}: ${smErr.message}. Fallback updating.`);
              await this.prisma.bookingRequest.update({
                where: { id: b.id },
                data: { status: BookingStatus.PENDING },
              });
            }
          } else {
            await this.prisma.bookingRequest.update({
              where: { id: b.id },
              data: { status: BookingStatus.PENDING },
            });
          }
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
