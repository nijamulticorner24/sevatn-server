import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccountLockService } from './account-lock.service';
import { BookingStatus, JobType } from '@prisma/client';

export interface AvailabilityEventPayload {
  date: string; // YYYY-MM-DD
  route: string;
  timeSlot: string;
  source?: string;
  detectedAt?: Date;
}

export interface MatchResult {
  matched: boolean;
  bookingId?: string;
  bookingCode?: string;
  message: string;
}

@Injectable()
export class SmartMatcherService {
  private readonly logger = new Logger(SmartMatcherService.name);

  constructor(
    private prisma: PrismaService,
    private accountLockService: AccountLockService,
  ) {}

  /**
   * Consumes an availability event and atomically matches it against the oldest
   * eligible pending booking for that exact date and route.
   * 
   * NEVER modifies a user's requested date.
   */
  async matchAvailabilityEvent(event: AvailabilityEventPayload): Promise<MatchResult> {
    const canonicalDateStr = event.date.trim();
    const [year, month, day] = canonicalDateStr.split('-').map(Number);
    const targetDateStart = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
    const targetDateEnd = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));

    this.logger.log(`[AVAILABILITY] 🟢 Date became available: ${canonicalDateStr}`);
    this.logger.log(`[MATCHER] Processing availability event: ${canonicalDateStr} | ${event.route} | ${event.timeSlot}`);

    // 1. Check & Record Idempotency
    const idempotencyKey = `${canonicalDateStr}|${event.route}|${event.timeSlot}`;
    const existingOpportunity = await this.prisma.availabilityOpportunity.findUnique({
      where: { idempotencyKey },
    });

    if (existingOpportunity && existingOpportunity.status === 'MATCHED') {
      this.logger.log(`[MATCHER] Opportunity ${idempotencyKey} already matched to Booking ${existingOpportunity.matchedBookingId}`);
      return {
        matched: false,
        message: 'Opportunity already claimed/matched by another booking',
      };
    }

    // Save or update opportunity record
    const opportunity = await this.prisma.availabilityOpportunity.upsert({
      where: { idempotencyKey },
      create: {
        idempotencyKey,
        date: canonicalDateStr,
        route: event.route,
        timeSlot: event.timeSlot,
        status: 'AVAILABLE',
        source: event.source || 'official-portal',
      },
      update: {
        detectedAt: new Date(),
      },
    });

    // 2. Query all eligible pending bookings strictly for this requestedDate (and matching route)
    // Ordered deterministically by createdAt ASC (Fairness: oldest first)
    const pendingBookings = await this.prisma.bookingRequest.findMany({
      where: {
        OR: [
          { requestedDateStr: canonicalDateStr },
          { requestedDate: { gte: targetDateStart, lte: targetDateEnd } },
        ],
        route: {
          contains: event.route.split(' ')[0], // matches 'Pamba' in 'Pamba (Regular Footpath Route)'
          mode: 'insensitive',
        },
        status: {
          in: [
            BookingStatus.PENDING,
            BookingStatus.QUEUED,
            BookingStatus.TEMPORARY_SLOT_LOST,
            BookingStatus.WAITING_FOR_ACCOUNT,
          ],
        },
      },
      orderBy: { createdAt: 'asc' },
      include: {
        account: true,
      },
    });

    const pendingCount = pendingBookings.length;
    this.logger.log(`[MATCHER] Found ${pendingCount} pending bookings for ${canonicalDateStr}`);

    if (pendingCount === 0) {
      return {
        matched: false,
        message: `No pending bookings found for ${canonicalDateStr} / ${event.route}`,
      };
    }

    // 3. Iterate through eligible bookings in strict createdAt order, checking Account Lock
    for (const booking of pendingBookings) {
      this.logger.log(`[MATCHER] Pending booking found: ${booking.bookingCode}`);

      // Check Same Account Protection
      if (booking.accountId) {
        const isLocked = await this.accountLockService.isLocked(booking.accountId);
        if (isLocked) {
          this.logger.log(`[MATCHER] Booking #${booking.bookingCode} account (${booking.account?.username}) is currently busy. Marking WAITING_FOR_ACCOUNT and evaluating next.`);
          await this.prisma.bookingRequest.update({
            where: { id: booking.id },
            data: { status: BookingStatus.WAITING_FOR_ACCOUNT },
          });
          continue;
        }
      }

      // 4. Perform Atomic Claim on the booking
      const claimed = await this.atomicClaimBooking(booking.id, event.timeSlot);
      if (claimed) {
        // Acquire Account Lock if account is linked
        if (booking.accountId) {
          await this.accountLockService.acquireLock(booking.accountId, booking.id);
        }

        // Link opportunity to claimed booking
        await this.prisma.availabilityOpportunity.update({
          where: { id: opportunity.id },
          data: {
            status: 'MATCHED',
            matchedBookingId: booking.id,
          },
        });

        this.logger.log(`[MATCHER] Booking claimed: ${booking.bookingCode}`);
        this.logger.log(`[QUEUE] Booking execution queued immediately`);

        return {
          matched: true,
          bookingId: booking.id,
          bookingCode: booking.bookingCode,
          message: `Successfully matched Booking #${booking.bookingCode} to ${canonicalDateStr} slot ${event.timeSlot}`,
        };
      }
    }

    return {
      matched: false,
      message: 'All matching bookings were claimed or their accounts were busy',
    };
  }

  /**
   * Performs an atomic claim of a pending booking request and queues the execution job.
   */
  private async atomicClaimBooking(bookingId: string, timeSlot: string): Promise<boolean> {
    const now = new Date();

    return await this.prisma.$transaction(async (tx) => {
      // 1. Atomic conditional update: only transitions if booking is currently in a pending state
      const updateResult = await tx.bookingRequest.updateMany({
        where: {
          id: bookingId,
          status: {
            in: [
              BookingStatus.PENDING,
              BookingStatus.QUEUED,
              BookingStatus.TEMPORARY_SLOT_LOST,
              BookingStatus.WAITING_FOR_ACCOUNT,
            ],
          },
        },
        data: {
          status: BookingStatus.CLAIMED,
          selectedTime: timeSlot,
          matchedAt: now,
        },
      });

      if (updateResult.count === 0) {
        // Lost race condition: another scheduler or worker claimed it
        return false;
      }

      // 2. Transition state to EXECUTION_QUEUED
      await tx.bookingRequest.update({
        where: { id: bookingId },
        data: { status: BookingStatus.EXECUTION_QUEUED },
      });

      // 3. Upsert or create the BookingJob in QUEUED status ready for Playwright worker pickup
      const existingJob = await tx.bookingJob.findFirst({
        where: {
          bookingRequestId: bookingId,
          jobType: JobType.BOOKING_EXECUTION,
          status: {
            in: [BookingStatus.QUEUED, BookingStatus.WORKER_ASSIGNED, BookingStatus.TEMPORARY_SLOT_LOST],
          },
        },
      });

      if (existingJob) {
        await tx.bookingJob.update({
          where: { id: existingJob.id },
          data: {
            status: BookingStatus.QUEUED,
            workerId: null,
            startedAt: null,
            leaseExpiresAt: null,
          },
        });
      } else {
        const booking = await tx.bookingRequest.findUnique({ where: { id: bookingId } });
        await tx.bookingJob.create({
          data: {
            jobType: JobType.BOOKING_EXECUTION,
            bookingRequestId: bookingId,
            accountId: booking?.accountId || null,
            status: BookingStatus.QUEUED,
          },
        });
      }

      return true;
    });
  }

  /**
   * Unlocks and returns a booking to PENDING state when a temporary slot race condition occurs.
   * Guaranteed: requestedDate remains 100% UNCHANGED.
   */
  async returnToPendingOnSlotLoss(bookingId: string, reason?: string): Promise<void> {
    const booking = await this.prisma.bookingRequest.findUnique({
      where: { id: bookingId },
    });

    if (!booking) return;

    this.logger.warn(`[MATCHER] Slot lost for Booking #${booking.bookingCode}. Returning to PENDING on requested date: ${booking.requestedDate.toISOString().split('T')[0]}`);

    // Release Account Lock
    if (booking.accountId) {
      await this.accountLockService.releaseLock(booking.accountId, booking.id);
    }

    // Reset BookingRequest to PENDING (requestedDate stays intact!)
    await this.prisma.bookingRequest.update({
      where: { id: bookingId },
      data: {
        status: BookingStatus.PENDING,
        assignedMachineId: null,
        leaseExpiresAt: null,
        failureReason: reason || 'Temporary slot unavailable on portal; returned to pending queue',
      },
    });

    // Reset BookingJob
    await this.prisma.bookingJob.updateMany({
      where: { bookingRequestId: bookingId },
      data: {
        status: BookingStatus.PENDING,
        workerId: null,
        leaseExpiresAt: null,
      },
    });
  }
}
