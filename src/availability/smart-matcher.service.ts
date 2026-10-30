import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AccountLockService } from './account-lock.service';
import { BookingStateMachineService } from '../bookings/booking-state-machine.service';
import { BookingStatus, JobType, AccountStatus } from '@prisma/client';

export interface AvailabilityEventPayload {
  date: string; // YYYY-MM-DD
  route: string;
  timeSlot?: string;
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
    @Optional() private stateMachine?: BookingStateMachineService,
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
    this.logger.log(`[MATCHER] Processing availability event: ${canonicalDateStr} | ${event.route}${event.timeSlot ? ` | ${event.timeSlot}` : ''}`);

    // 1. Check & Record Idempotency
    const idempotencyKey = event.timeSlot
      ? `${canonicalDateStr}|${event.route}|${event.timeSlot}`
      : `${canonicalDateStr}|${event.route}`;
    const existingOpportunity = await this.prisma.availabilityOpportunity.findUnique({
      where: { idempotencyKey },
    });

    let isStaleRecovery = false;
    let staleBookingId: string | null = null;

    if (existingOpportunity && existingOpportunity.status === 'MATCHED') {
      const matchedBookingId = existingOpportunity.matchedBookingId;

      if (!matchedBookingId) {
        // Opportunity has status MATCHED but no associated booking ID
        isStaleRecovery = true;
        staleBookingId = null;
        this.logger.log(`[MATCHER] Opportunity ${idempotencyKey} is MATCHED but has no matchedBookingId. Permitting stale-match recovery.`);
      } else {
        const matchedBooking = await this.prisma.bookingRequest.findUnique({
          where: { id: matchedBookingId },
          select: { id: true, bookingCode: true, status: true },
        });

        // Strict terminal/completed status policy: CANCELLED, FAILED, EXPIRED, LOGIN_FAILED, WORKER_ERROR, SITE_ERROR, TIMEOUT, SUCCESS, COMPLETED (or missing) permit recovery
        const terminalStatuses: BookingStatus[] = [
          BookingStatus.CANCELLED,
          BookingStatus.FAILED,
          BookingStatus.EXPIRED,
          BookingStatus.LOGIN_FAILED,
          BookingStatus.WORKER_ERROR,
          BookingStatus.SITE_ERROR,
          BookingStatus.TIMEOUT,
          BookingStatus.SUCCESS,
          BookingStatus.COMPLETED,
        ];

        const isTerminalBooking = !matchedBooking || terminalStatuses.includes(matchedBooking.status);

        if (!isTerminalBooking) {
          this.logger.log(
            `[MATCHER] Opportunity ${idempotencyKey} already matched to active Booking #${matchedBooking.bookingCode} (status: ${matchedBooking.status})`,
          );
          return {
            matched: false,
            message: 'Opportunity already claimed/matched by another booking',
          };
        }

        // Matched booking is terminal/missing. Verify no active in-flight booking job still owns it.
        const terminalJobStatuses: BookingStatus[] = [
          BookingStatus.CANCELLED,
          BookingStatus.FAILED,
          BookingStatus.COMPLETED,
          BookingStatus.SUCCESS,
          BookingStatus.BOOKING_CONFIRMED,
          BookingStatus.WORKER_ERROR,
          BookingStatus.SITE_ERROR,
          BookingStatus.TIMEOUT,
          BookingStatus.EXPIRED,
          BookingStatus.LOGIN_FAILED,
          BookingStatus.DATE_SELECTION_FAILED,
          BookingStatus.DATE_VERIFICATION_FAILED,
          BookingStatus.DATE_AVAILABILITY_TIMEOUT,
          BookingStatus.PILGRIM_SELECTION_FAILED,
          BookingStatus.SUBMIT_FAILED,
          BookingStatus.CAPTCHA_REQUIRED,
          BookingStatus.OTP_REQUIRED,
          BookingStatus.SITE_UNAVAILABLE,
          BookingStatus.UNKNOWN,
          BookingStatus.UNKNOWN_RESULT,
          BookingStatus.REQUIRES_HUMAN,
          BookingStatus.DATE_UNAVAILABLE,
          BookingStatus.ROUTE_UNAVAILABLE,
          BookingStatus.NO_AVAILABILITY,
          BookingStatus.TEMPORARY_SLOT_LOST,
        ];

        const now = new Date();
        const activeJob = await this.prisma.bookingJob.findFirst({
          where: {
            bookingRequestId: matchedBookingId,
            status: {
              notIn: terminalJobStatuses,
            },
            OR: [
              {
                status: {
                  in: [
                    BookingStatus.QUEUED,
                    BookingStatus.EXECUTION_QUEUED,
                    ((BookingStatus as any).FAST_BOOKING_QUEUED || 'FAST_BOOKING_QUEUED') as any,
                  ],
                },
              },
              {
                leaseExpiresAt: { gt: now },
              },
            ],
          },
        });

        if (activeJob) {
          this.logger.warn(
            `[MATCHER] Opportunity ${idempotencyKey} matched Booking #${matchedBooking?.bookingCode || matchedBookingId} is ${matchedBooking?.status || 'MISSING'}, but active Job #${activeJob.id} (status: ${activeJob.status}) is still in flight. Recovery blocked.`,
          );
          return {
            matched: false,
            message: 'Opportunity has active in-flight execution job',
          };
        }

        // Safe for stale-match recovery
        isStaleRecovery = true;
        staleBookingId = matchedBookingId;
        this.logger.log(
          `[MATCHER] Opportunity ${idempotencyKey} previously matched to Booking #${matchedBooking?.bookingCode || matchedBookingId} (${matchedBooking?.status || 'MISSING'}), which is terminal with 0 active jobs. Permitting stale-match recovery.`,
        );
      }
    }

    // Save or update opportunity record
    const opportunity = await this.prisma.availabilityOpportunity.upsert({
      where: { idempotencyKey },
      create: {
        idempotencyKey,
        date: canonicalDateStr,
        route: event.route,
        timeSlot: event.timeSlot || 'DATE_ONLY',
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
        pilgrims: true,
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

    // 3. Iterate through eligible bookings in strict createdAt order, verifying readiness and Account Lock
    for (const booking of pendingBookings) {
      this.logger.log(`[MATCHER] Evaluating pending booking: #${booking.bookingCode}`);

      // Readiness Check 1: Devotee Account must exist and be VERIFIED
      if (!booking.accountId || !booking.account || booking.account.status !== AccountStatus.VERIFIED) {
        this.logger.warn(`[MATCHER] Booking #${booking.bookingCode} skipped: official account is not verified (status: ${booking.account?.status || 'none'}).`);
        continue;
      }

      // Readiness Check 2: Devotees are selected from official portal account profile; ensure valid nominee details exist
      const hasNominee = !!((booking as any).nomineeName || (booking.pilgrims && booking.pilgrims.some((p: any) => p.nomineeName)));
      if (!hasNominee) {
        this.logger.warn(`[MATCHER] Booking #${booking.bookingCode} skipped: missing required nominee details.`);
        continue;
      }

      // Readiness Check 4: Check Same Account Protection
      if (booking.accountId) {
        const isLocked = await this.accountLockService.isLocked(booking.accountId);
        if (isLocked) {
          this.logger.log(`[MATCHER] Booking #${booking.bookingCode} account (${booking.account?.username}) is currently busy. Marking WAITING_FOR_ACCOUNT and evaluating next.`);
          if (this.stateMachine) {
            try {
              await this.stateMachine.transition({
                bookingId: booking.id,
                targetStatus: BookingStatus.WAITING_FOR_ACCOUNT,
                milestone: 'ACCOUNT_BUSY_WAITING',
              });
            } catch (smErr: any) {
              await this.prisma.bookingRequest.update({
                where: { id: booking.id },
                data: { status: BookingStatus.WAITING_FOR_ACCOUNT },
              });
            }
          } else {
            await this.prisma.bookingRequest.update({
              where: { id: booking.id },
              data: { status: BookingStatus.WAITING_FOR_ACCOUNT },
            });
          }
          continue;
        }
      }

      // 4. Perform Atomic Claim on the booking and atomically reassign the opportunity
      const claimed = await this.atomicClaimBooking(
        booking.id,
        opportunity.id,
        event.timeSlot,
        isStaleRecovery,
        staleBookingId,
      );
      if (claimed) {
        // Acquire Account Lock if account is linked
        if (booking.accountId) {
          await this.accountLockService.acquireLock(booking.accountId, booking.id);
        }

        this.logger.log(`[MATCHER] Booking claimed: ${booking.bookingCode}`);
        this.logger.log(`[QUEUE] Booking execution job created and queued in QUEUED state: #${booking.bookingCode}`);

        return {
          matched: true,
          bookingId: booking.id,
          bookingCode: booking.bookingCode,
          message: isStaleRecovery
            ? `Successfully matched Booking #${booking.bookingCode} to ${canonicalDateStr} / ${event.route} (recovered stale match)`
            : `Successfully matched Booking #${booking.bookingCode} to ${canonicalDateStr} / ${event.route}`,
        };
      }
    }

    return {
      matched: false,
      message: 'All matching bookings were claimed or their accounts were busy',
    };
  }

  /**
   * Performs an atomic claim of a pending booking request and queues the execution job,
   * while atomically associating the opportunity to prevent race conditions.
   */
  private async atomicClaimBooking(
    bookingId: string,
    opportunityId: string,
    timeSlot?: string,
    isStaleRecovery: boolean = false,
    staleBookingId?: string | null,
  ): Promise<boolean> {
    const now = new Date();

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. Atomic conditional update: only transitions if booking is currently in an eligible pending state
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
            selectedTime: timeSlot || null,
            matchedAt: now,
            version: { increment: 1 },
          },
        });

        if (updateResult.count === 0) {
          // Lost race condition: another scheduler or worker claimed it
          return false;
        }

        // 2. Atomic conditional update on availabilityOpportunity
        // Only reassign if opportunity is still AVAILABLE, or matches the expected stale booking
        const oppConditions: any[] = [{ status: 'AVAILABLE' }];
        if (isStaleRecovery) {
          oppConditions.push({
            status: 'MATCHED',
            matchedBookingId: staleBookingId ?? null,
          });
        }

        const oppUpdateResult = await tx.availabilityOpportunity.updateMany({
          where: {
            id: opportunityId,
            OR: oppConditions,
          },
          data: {
            status: 'MATCHED',
            matchedBookingId: bookingId,
          },
        });

        if (oppUpdateResult.count === 0) {
          // Concurrency conflict: another concurrent event claimed or reassigned this opportunity
          throw new Error('OPPORTUNITY_CONCURRENCY_CONFLICT');
        }

        // 3. Transition state to EXECUTION_QUEUED via state machine or atomic update
        if (this.stateMachine) {
          try {
            await this.stateMachine.transition(
              {
                bookingId,
                targetStatus: BookingStatus.EXECUTION_QUEUED,
                milestone: 'MATCHED_AND_EXECUTION_QUEUED',
              },
              tx,
            );
          } catch (smErr: any) {
            await tx.bookingRequest.update({
              where: { id: bookingId },
              data: { status: BookingStatus.EXECUTION_QUEUED, version: { increment: 1 } },
            });
          }
        } else {
          await tx.bookingRequest.update({
            where: { id: bookingId },
            data: { status: BookingStatus.EXECUTION_QUEUED, version: { increment: 1 } },
          });
        }

        // 4. Upsert or create the BookingJob in QUEUED status ready for Playwright worker pickup
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
          this.logger.log(`[MATCHER] Execution job ID #${existingJob.id} reset to QUEUED state for Booking #${bookingId}`);
        } else {
          const booking = await tx.bookingRequest.findUnique({ where: { id: bookingId } });
          const newJob = await tx.bookingJob.create({
            data: {
              jobType: JobType.BOOKING_EXECUTION,
              bookingRequestId: bookingId,
              accountId: booking?.accountId || null,
              status: BookingStatus.QUEUED,
            },
          });
          this.logger.log(`[MATCHER] Execution job created with ID #${newJob.id} in QUEUED state for Booking #${booking?.bookingCode || bookingId}`);
        }

        return true;
      });
    } catch (err: any) {
      if (err.message === 'OPPORTUNITY_CONCURRENCY_CONFLICT') {
        this.logger.warn(`[MATCHER] Concurrency conflict: Opportunity #${opportunityId} was already claimed by another event.`);
        return false;
      }
      throw err;
    }
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

    // Reset BookingRequest to PENDING (requestedDate stays intact!) via State Machine
    if (this.stateMachine) {
      try {
        await this.stateMachine.transition({
          bookingId,
          targetStatus: BookingStatus.PENDING,
          assignedMachineId: null,
          leaseExpiresAt: null,
          failureReason: reason || 'Temporary slot unavailable on portal; returned to pending queue',
          milestone: 'RETURNED_TO_PENDING_ON_SLOT_LOSS',
        });
      } catch (smErr: any) {
        await this.prisma.bookingRequest.update({
          where: { id: bookingId },
          data: {
            status: BookingStatus.PENDING,
            assignedMachineId: null,
            leaseExpiresAt: null,
            failureReason: reason || 'Temporary slot unavailable on portal; returned to pending queue',
          },
        });
      }
    } else {
      await this.prisma.bookingRequest.update({
        where: { id: bookingId },
        data: {
          status: BookingStatus.PENDING,
          assignedMachineId: null,
          leaseExpiresAt: null,
          failureReason: reason || 'Temporary slot unavailable on portal; returned to pending queue',
        },
      });
    }

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
