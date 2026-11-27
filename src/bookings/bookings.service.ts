import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CredentialCrypto } from '../common/security/credential-crypto';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { AccountLockService } from '../availability/account-lock.service';
import { CreateBookingDto, ResolveHumanActionDto } from './dto/booking.dto';
import { BookingStatus, JobType, AccountStatus, Role, Prisma } from '@prisma/client';
import { calculateHaversineDistanceKm } from '../common/utils/geo';
import { getTodayISTDateString, isDateInPast, SabarimalaRoute, normalizeSabarimalaRoute, getOfficialSabarimalaRouteLabel, isRouteMatching } from '../common/booking-status.constants';
import { validateNominee, OFFICIAL_SABARIMALA_RELATIONSHIPS } from '../common/nominee-validator';

import { EventsGateway } from '../events/events.gateway';
import { SmartAllocatorService } from '../workers/smart-allocator.service';
import { BookingStateMachineService } from './booking-state-machine.service';
import { TicketPricingService } from '../pricing/ticket-pricing.service';
import { Optional } from '@nestjs/common';

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    private prisma: PrismaService,
    private walletService: WalletService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private smartMatcher: SmartMatcherService,
    private accountLockService: AccountLockService,
    private eventsGateway: EventsGateway,
    private stateMachine: BookingStateMachineService,
    private pricingService: TicketPricingService,
    @Optional() private smartAllocator?: SmartAllocatorService,
  ) {}

  /**
   * Create a new official Sabarimala booking request with pre-queue validation gating.
   * Ensures account verification, pilgrim details, and nominee requirements are satisfied
   * before admission into queue / pending demand index.
   */
  async createBooking(userId: string, dto: CreateBookingDto) {
    if (dto.termsAccepted !== true) {
      throw new BadRequestException(
        'Please accept the Terms & Conditions and Refund Policy before continuing.',
      );
    }

    if (!dto.requestedDate || !dto.route) {
      throw new BadRequestException('Preferred Darshan Date and Route are required');
    }

    const canonicalRouteEnum = normalizeSabarimalaRoute(dto.route);
    if (!canonicalRouteEnum) {
      throw new BadRequestException(
        `Unsupported or unrecognized route "${dto.route}". Must match one of the official Sabarimala Darshan routes (Pamba, Erumely Traditional, or Vandiperiyar/Pulmedu).`,
      );
    }
    const validatedOfficialRoute = getOfficialSabarimalaRouteLabel(canonicalRouteEnum);

    // 1. Business Logic: One BookingRequest = 1 Account + 1 Date + 1 Route + 1 to 10 Selected Saved Pilgrims + Nominee details
    let requestedPilgrimCount = 1;
    if (dto.pilgrimCount !== undefined && dto.pilgrimCount !== null) {
      const parsedCount = Number(dto.pilgrimCount);
      if (!Number.isInteger(parsedCount) || parsedCount < 1 || parsedCount > 10) {
        throw new BadRequestException(
          'Sabarimala portal allows 1 to 10 pilgrims per booking (pilgrimCount must be an integer between 1 and 10).',
        );
      }
      requestedPilgrimCount = parsedCount;
    } else if (dto.pilgrims && Array.isArray(dto.pilgrims) && dto.pilgrims.length > 0) {
      if (dto.pilgrims.length > 10) {
        throw new BadRequestException(
          'Sabarimala portal allows a maximum of 10 pilgrims per booking.',
        );
      }
      requestedPilgrimCount = dto.pilgrims.length;
    } else if (dto.nominees && Array.isArray(dto.nominees) && dto.nominees.length > 1) {
      if (dto.nominees.length > 10) {
        throw new BadRequestException(
          'Sabarimala portal allows a maximum of 10 nominee entries per booking.',
        );
      }
      requestedPilgrimCount = dto.nominees.length;
    }

    if (dto.pilgrims && Array.isArray(dto.pilgrims) && dto.pilgrims.length > 10) {
      throw new BadRequestException(
        'Sabarimala portal allows a maximum of 10 pilgrims per booking.',
      );
    }
    if (dto.nominees && Array.isArray(dto.nominees) && dto.nominees.length > 10) {
      throw new BadRequestException(
        'Sabarimala portal allows a maximum of 10 nominee entries per booking.',
      );
    }
    if (dto.pilgrims && Array.isArray(dto.pilgrims) && dto.pilgrims.length > 0) {
      for (const p of dto.pilgrims) {
        if (!p.fullName || !p.fullName.trim() || !p.age || Number(p.age) < 1 || Number(p.age) > 120 || !p.gender || !p.idType || !p.idNumber || !p.idNumber.trim()) {
          throw new BadRequestException('Each explicitly provided pilgrim record must contain a valid fullName, age (1-120), gender, idType, and idNumber.');
        }
      }
    }

    // 2. Mandatory Nominee Details & Official Relationship Validation
    const nomineeCheck = validateNominee(dto, {
      allowOptional: false,
      strictOfficialRelationship: true,
    });
    if (!nomineeCheck.valid || !nomineeCheck.resolvedNominee) {
      throw new BadRequestException(
        nomineeCheck.errors[0] ||
          `Valid nominee details (full name, adult age 18-120, and relationship from: ${OFFICIAL_SABARIMALA_RELATIONSHIPS.join(', ')}) are required.`,
      );
    }
    const resolvedNominee = nomineeCheck.resolvedNominee;
    const baseNominees = nomineeCheck.resolvedNominees && nomineeCheck.resolvedNominees.length > 0
      ? nomineeCheck.resolvedNominees
      : [resolvedNominee];
    const resolvedNominees = Array.from({ length: requestedPilgrimCount }, (_, idx) => baseNominees[idx] || resolvedNominee);

    // Verify user role & registered centre location: Strictly CENTRE, DISTRIBUTOR, or SUPER_ADMIN
    const callingUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, registeredLocation: true },
    });
    if (!callingUser || (callingUser.role !== Role.CENTRE && callingUser.role !== Role.DISTRIBUTOR && callingUser.role !== Role.SUPER_ADMIN)) {
      throw new ForbiddenException(
        'Booking creation is exclusively restricted to registered and active Centre operators, Distributors, and Super Admins.',
      );
    }

    // 2b. Location 5 KM Geofence Enforcement (defence-in-depth, applicable to Centres)
    if (callingUser.role === Role.CENTRE && callingUser.registeredLocation) {
      if (dto.latitude !== undefined && dto.longitude !== undefined) {
        const distanceKm = calculateHaversineDistanceKm(
          { latitude: dto.latitude, longitude: dto.longitude },
          {
            latitude: callingUser.registeredLocation.latitude,
            longitude: callingUser.registeredLocation.longitude,
          },
        );
        if (distanceKm > 5.0) {
          throw new ForbiddenException(
            `Access Denied: You are ${distanceKm} KM away from your registered centre. ` +
              `Access is permitted strictly within a 5.0 KM radius under SevaTN security policy.`,
          );
        }
      }
    }

    // 3. Official Devotee Account Validation & Ownership
    let accountId = dto.accountId;
    let isNewAccountCredentials = false;

    if (!accountId && (!dto.username || !dto.password)) {
      throw new BadRequestException('Official devotee account credentials or saved account ID is required.');
    }

    if (accountId) {
      const existingAccount = await this.prisma.bookingAccount.findUnique({
        where: { id: accountId },
      });
      if (!existingAccount) {
        throw new NotFoundException('Selected devotee account was not found.');
      }
      if (existingAccount.userId !== userId && callingUser.role !== Role.SUPER_ADMIN) {
        throw new ForbiddenException('You do not have permission to use this devotee account.');
      }
      if (existingAccount.status !== AccountStatus.VERIFIED) {
        throw new BadRequestException(
          `Devotee account credentials must be verified before booking can proceed. Current status: ${existingAccount.status}`,
        );
      }
    } else {
      isNewAccountCredentials = true;
    }

    // 3b. Devotee Profile Single Active Request Gate:
    // A Devotee Profile can only have 1 active booking request at a time.
    // Multiple dates or concurrent requests on the same devotee profile are strictly prohibited.
    const nonTerminalStatuses: BookingStatus[] = [
      BookingStatus.NEW,
      BookingStatus.AVAILABILITY_CHECKING,
      BookingStatus.DRAFT,
      BookingStatus.PENDING,
      BookingStatus.SUBMITTED,
      BookingStatus.QUEUED,
      BookingStatus.FAST_BOOKING_QUEUED,
      BookingStatus.MATCHING,
      BookingStatus.CLAIMED,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.EXECUTING,
      BookingStatus.WAITING_FOR_ACCOUNT,
      BookingStatus.WORKER_ASSIGNED,
      BookingStatus.ASSIGNED,
      BookingStatus.BROWSER_STARTING,
      BookingStatus.OFFICIAL_SITE_OPEN,
      BookingStatus.OPENING_OFFICIAL_SITE,
      BookingStatus.LOGIN_IN_PROGRESS,
      BookingStatus.LOGIN_SUCCESS,
      BookingStatus.BOOKING_FLOW_STARTED,
      BookingStatus.OPENING_VIRTUAL_Q,
      BookingStatus.WAITING_FOR_DATE_AVAILABILITY,
      BookingStatus.DATE_AVAILABLE,
      BookingStatus.SELECTING_DATE,
      BookingStatus.VERIFYING_DATE_SELECTION,
      BookingStatus.DATE_SELECTION_VERIFIED,
      BookingStatus.SELECTING_ROUTE,
      BookingStatus.DATE_VERIFIED,
      BookingStatus.ROUTE_VERIFIED,
      BookingStatus.SLOT_VERIFIED,
      BookingStatus.OPENING_PILGRIM_SELECTION,
      BookingStatus.SELECTING_EXISTING_PILGRIMS,
      BookingStatus.PILGRIMS_VERIFIED,
      BookingStatus.SUBMITTING_PILGRIMS,
      BookingStatus.NOMINEE_VERIFIED,
      BookingStatus.SELECTING_RELIEF_FUND_NO,
      BookingStatus.RELIEF_VERIFIED,
      BookingStatus.ADDING_TO_WISHLIST,
      BookingStatus.VERIFYING_RESULT,
      BookingStatus.WISHLIST_ADDED,
      BookingStatus.WISHLIST_VERIFIED,
      BookingStatus.PROCEEDING_TO_CHECKOUT,
      BookingStatus.CHECKOUT_VERIFIED,
      BookingStatus.ZERO_COST_CONFIRMATION_PENDING,
      BookingStatus.CONFIRMATION_PENDING,
      BookingStatus.DISCOVERING,
      BookingStatus.CHECKING_AVAILABILITY,
      BookingStatus.WATCHING,
      BookingStatus.WAITING,
      BookingStatus.AVAILABILITY_FOUND,
      BookingStatus.BOOKING_IN_PROGRESS,
      BookingStatus.BOOKING,
      BookingStatus.CONFIRMATION_CHECK,
      BookingStatus.HOLD_INVALID_NOMINEE,
      BookingStatus.TEMPORARY_SLOT_LOST,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CAPTCHA_REQUIRED,
      BookingStatus.OTP_REQUIRED,
    ];

    let checkAccountId = accountId;
    if (!checkAccountId && dto.username) {
      const existingAcct = await this.prisma.bookingAccount.findUnique({
        where: {
          userId_username: {
            userId,
            username: dto.username.trim(),
          },
        },
      });
      if (existingAcct) {
        checkAccountId = existingAcct.id;
      }
    }

    if (checkAccountId) {
      const activeBooking = await this.prisma.bookingRequest.findFirst({
        where: {
          accountId: checkAccountId,
          status: { in: nonTerminalStatuses },
        },
        select: {
          id: true,
          bookingCode: true,
          requestedDate: true,
          requestedDateStr: true,
          status: true,
        },
      });

      if (activeBooking) {
        const dateDisplay =
          activeBooking.requestedDateStr ||
          (activeBooking.requestedDate ? activeBooking.requestedDate.toISOString().split('T')[0] : 'scheduled date');
        throw new BadRequestException(
          `This devotee profile already has an active booking request (#${activeBooking.bookingCode} for ${dateDisplay}, status: ${activeBooking.status}). Only 1 active booking request is permitted per devotee profile. Multiple dates or duplicate requests on the same profile are not allowed until the active request is finalized or cancelled.`,
        );
      }
    }

    // 4. Idempotency Guard (Avoid duplicate wallet holds and requests)
    if (dto.idempotencyKey) {
      const existingTx = await this.prisma.walletTransaction.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
        include: {
          booking: {
            include: {
              pilgrims: true,
              account: { select: { id: true, username: true, status: true } },
            },
          },
        },
      });
      if (existingTx && existingTx.booking) {
        this.logger.log(`[BOOKING] Idempotent replay for key: ${dto.idempotencyKey} -> #${existingTx.booking.bookingCode}`);
        return existingTx.booking;
      }
    }

    const rawDateStr = dto.requestedDate.split('T')[0];
    const [year, month, day] = rawDateStr.split('-').map(Number);
    const canonicalDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));

    const config = await this.prisma.systemConfig.findUnique({
      where: { id: 'default' },
    });
    const baseServiceFee = Number(config?.serviceFee ?? 20);

    const pilgrimCount = requestedPilgrimCount;

    // Calculate immutable 3-level ticket price breakdown snapshot (Base Price + Franchise/Partner Markup + Distributor Markup)
    const priceCalculation = await this.pricingService.calculateBookingPrice({
      userId,
      quantity: pilgrimCount,
    });
    const unitPrice = Number(priceCalculation?.finalTicketPrice) || baseServiceFee;
    const feeAmount = Number(priceCalculation?.totalTicketAmount) || (unitPrice * pilgrimCount);

    const result = await this.prisma.$transaction(async (tx) => {
      // 0. Generate guaranteed collision-free booking code inside transaction
      const bookingCode = await this.generateUniqueBookingCode(tx);

      // 1. Verify and reserve funds from wallet
      let wallet = await tx.wallet.findUnique({ where: { userId } });
      const userRecord = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
      const isSuperAdmin = userRecord?.role === Role.SUPER_ADMIN;

      if (!wallet) {
        wallet = await tx.wallet.create({
          data: {
            userId,
            availableBalance: isSuperAdmin ? 100000 : 0,
            reservedBalance: 0,
          },
        });
      } else if (isSuperAdmin && Number(wallet.availableBalance) < feeAmount) {
        wallet = await tx.wallet.update({
          where: { userId },
          data: {
            availableBalance: 100000,
          },
        });
      }

      if (!isSuperAdmin && Number(wallet.availableBalance) < feeAmount) {
        throw new BadRequestException(
          `Insufficient wallet balance. Required: ₹ ${feeAmount} (₹ ${unitPrice} × ${pilgrimCount} pilgrim${pilgrimCount > 1 ? 's' : ''}), Available: ₹ ${wallet?.availableBalance || 0}`,
        );
      }

      // 2. Handle Official Devotee Account credentials (if newly provided)
      if (dto.username && dto.password) {
        const { encryptedData, iv, authTag } = CredentialCrypto.encrypt(dto.password);
        const resolvedLabel = (dto.label || dto.accountLabel)?.trim() || null;
        const account = await (tx.bookingAccount as any).upsert({
          where: {
            userId_username: {
              userId,
              username: dto.username.trim(),
            },
          },
          create: {
            userId,
            username: dto.username.trim(),
            label: resolvedLabel,
            encryptedPassword: encryptedData,
            encryptionIv: iv,
            encryptionTag: authTag,
            status: AccountStatus.UNVERIFIED,
          },
          update: {
            ...(resolvedLabel ? { label: resolvedLabel } : {}),
            encryptedPassword: encryptedData,
            encryptionIv: iv,
            encryptionTag: authTag,
            status: AccountStatus.UNVERIFIED,
            verificationNote: null,
          },
        });
        accountId = account.id;

        // Trigger asynchronous account verification job for worker pickup
        await tx.bookingJob.create({
          data: {
            jobType: JobType.ACCOUNT_VERIFICATION,
            accountId: account.id,
            status: BookingStatus.QUEUED,
          },
        });
      }

      // 3. Execution Readiness Check (Remove premature QUEUED creation)
      let initialStatus: BookingStatus = BookingStatus.PENDING;
      let matchedTimeSlot: string | null = null;
      let shouldCreateExecutionJob = false;

      // Only attempt immediate execution dispatch if account is already confirmed VERIFIED
      if (!isNewAccountCredentials && accountId) {
        const availableOpps = await tx.availabilityOpportunity.findMany({
          where: {
            date: rawDateStr,
            status: 'AVAILABLE',
          },
        });
        const availableOpp = availableOpps.find((opp) => isRouteMatching(opp.route, validatedOfficialRoute));

        if (availableOpp) {
          const isLocked = await this.accountLockService.isLocked(accountId);
          if (!isLocked) {
            await this.accountLockService.acquireLock(accountId, bookingCode);
            await tx.availabilityOpportunity.update({
              where: { id: availableOpp.id },
              data: {
                status: 'MATCHED',
              },
            });
            initialStatus = BookingStatus.EXECUTION_QUEUED;
            matchedTimeSlot = availableOpp.timeSlot;
            shouldCreateExecutionJob = true;
          }
        }
      }

      // 4. Create Booking Request with verified pilgrims and nominee details
      const booking = await tx.bookingRequest.create({
        data: {
          bookingCode,
          userId,
          accountId: accountId || null,
          requestedDate: canonicalDate,
          requestedDateStr: rawDateStr,
          route: validatedOfficialRoute,
          pilgrimCount,
          timeSlot: dto.timeSlot || 'Any Slot',
          selectedTime: matchedTimeSlot || undefined,
          nomineeName: resolvedNominee?.nomineeName ? resolvedNominee.nomineeName.trim() : null,
          nomineeAge: resolvedNominee?.nomineeAge ? Number(resolvedNominee.nomineeAge) : null,
          nomineeRelationship: resolvedNominee?.nomineeRelationship ? resolvedNominee.nomineeRelationship.trim() : null,
          nomineePhone: resolvedNominee?.nomineePhone ? resolvedNominee.nomineePhone.trim() : null,
          nomineeValidationStatus: 'VALIDATED',
          lastMilestone: 'NOMINEE_VALIDATED',
          preferences: {
            ...(dto.preferences || {}),
            nominees: resolvedNominees,
            termsAccepted: true,
            termsAcceptedAt: new Date().toISOString(),
          },
          status: initialStatus,
          financialStatus: 'RESERVED',
          // Three-Level Ticket Pricing Immutable Snapshot
          baseTicketPrice: new Prisma.Decimal(priceCalculation.baseTicketPrice),
          partnerMarkup: new Prisma.Decimal(priceCalculation.partnerMarkup),
          distributorMarkup: new Prisma.Decimal(priceCalculation.distributorMarkup),
          finalTicketPrice: new Prisma.Decimal(priceCalculation.finalTicketPrice),
          ticketQuantity: priceCalculation.ticketQuantity,
          totalTicketAmount: new Prisma.Decimal(priceCalculation.totalTicketAmount),
          pricingConfigVersion: priceCalculation.pricingConfigVersion,
          pricingSnapshot: priceCalculation.pricingSnapshot,
          pilgrims: {
            create: Array.from({ length: pilgrimCount }).map((_, idx) => {
              const explicitPilgrim = dto.pilgrims && dto.pilgrims[idx];
              const nom = (resolvedNominees && resolvedNominees[idx]) || resolvedNominee;
              return {
                fullName: explicitPilgrim?.fullName?.trim() || `Devotee #${idx + 1}`,
                age: explicitPilgrim?.age || 0,
                gender: explicitPilgrim?.gender?.toUpperCase() || 'MALE',
                idType: explicitPilgrim?.idType?.toUpperCase() || 'AADHAAR',
                idNumber: explicitPilgrim?.idNumber?.trim() || 'PENDING_PORTAL_SELECTION',
                photoUrl: explicitPilgrim?.photoUrl || null,
                nomineeName: (explicitPilgrim?.nomineeName || nom?.nomineeName || null)?.trim() || null,
                nomineeAge: explicitPilgrim?.nomineeAge || nom?.nomineeAge || null,
                nomineeRelationship: (explicitPilgrim?.nomineeRelationship || nom?.nomineeRelationship || null)?.trim() || null,
                nomineePhone: explicitPilgrim?.nomineePhone?.trim() || nom?.nomineePhone?.trim() || null,
                metadata: {
                  taskIndex: idx + 1,
                  taskStatus: 'PENDING',
                },
              };
            }),
          },
        } as any,
        include: {
          pilgrims: true,
          account: { select: { id: true, username: true, status: true } },
        },
      });

      // 5. Create BOOKING_EXECUTION job for worker pickup
      if (shouldCreateExecutionJob) {
        await tx.bookingJob.create({
          data: {
            jobType: JobType.BOOKING_EXECUTION,
            bookingRequestId: booking.id,
            accountId: accountId || null,
            status: BookingStatus.QUEUED,
          },
        });
        this.logger.log(`[BOOKING] Availability confirmed. Executable job queued for #${booking.bookingCode}`);
      }

      // 6. Reserve configured service fee in wallet hold ledger
      await tx.wallet.update({
        where: { userId },
        data: {
          availableBalance: { decrement: feeAmount },
          reservedBalance: { increment: feeAmount },
        },
      });

      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          userId,
          bookingId: booking.id,
          type: 'RESERVE',
          amount: feeAmount,
          status: 'COMPLETED',
          reference: `RES-${bookingCode}`,
          idempotencyKey: dto.idempotencyKey || `res_${booking.id}`,
        },
      });

      return booking;
    });

    // Record consent according to audit and data-retention design
    await this.audit.log({
      actorId: userId,
      actorType: 'USER',
      action: 'TERMS_ACCEPTED',
      entity: 'BookingRequest',
      entityId: result.id,
      metadata: {
        bookingCode: result.bookingCode,
        termsAccepted: true,
        acceptedAt: new Date().toISOString(),
        policyVersion: '2026-v1',
        termsUrl: '/terms-and-conditions',
        refundPolicyUrl: '/refund-policy',
      },
    });

    // Broadcast WebSocket Live Event
    this.eventsGateway.notifyBookingUpdated(result.id, userId, {
      bookingId: result.id,
      bookingCode: result.bookingCode,
      status: result.status,
      requestedDate: result.requestedDate,
      route: result.route,
      timestamp: new Date().toISOString(),
    });

    if (this.smartAllocator) {
      if (typeof this.smartAllocator.runAllocationSweep === 'function') {
        this.smartAllocator.runAllocationSweep().catch((err) => {
          this.logger.warn(`Proactive allocation error: ${err.message}`);
        });
      }
      if (typeof this.smartAllocator.runMonitoringAllocationSweep === 'function') {
        this.smartAllocator.runMonitoringAllocationSweep().catch((err) => {
          this.logger.warn(`Proactive monitoring allocation error: ${err.message}`);
        });
      }
    }

    // Dispatch real-time Telegram alert for new booking arrival
    this.notifications
      .sendTelegramBookingNotification({
        bookingId: result.id,
        bookingCode: result.bookingCode,
        status: result.status,
        isNew: true,
        route: result.route,
        requestedDate: result.requestedDate,
        selectedTime: (result as any).selectedTime || result.timeSlot || undefined,
        pilgrimCount: result.pilgrimCount,
      })
      .catch((err: any) =>
        this.logger.warn(`Failed to dispatch Telegram new booking alert: ${err.message}`),
      );

    return result;
  }

  /**
   * Automatically cancels pending/open bookings whose darshan date is strictly in the past.
   * Releases wallet reservations and frees account locks.
   */
  async autoCancelPastPendingBookings(userId?: string): Promise<{ cancelledCount: number; details: string[] }> {
    const todayIST = getTodayISTDateString();
    const details: string[] = [];

    const openStatuses: BookingStatus[] = [
      BookingStatus.PENDING,
      BookingStatus.FAST_BOOKING_QUEUED,
      BookingStatus.WATCHING,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.WAITING_FOR_ACCOUNT,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.QUEUED,
      BookingStatus.WAITING_FOR_DATE_AVAILABILITY,
      BookingStatus.TEMPORARY_SLOT_LOST,
      BookingStatus.HOLD_INVALID_NOMINEE,
      BookingStatus.WORKER_ASSIGNED,
      BookingStatus.EXECUTING,
      BookingStatus.CHECKING_AVAILABILITY,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.CAPTCHA_REQUIRED,
      BookingStatus.OTP_REQUIRED,
      BookingStatus.ASSIGNED,
      BookingStatus.LOGIN_IN_PROGRESS,
      BookingStatus.BOOKING_IN_PROGRESS,
    ];

    const where: any = {
      status: { in: openStatuses },
    };
    if (userId) {
      where.userId = userId;
    }

    let openBookings: any[] = [];
    try {
      openBookings = await this.prisma.bookingRequest.findMany({
        where,
        select: {
          id: true,
          bookingCode: true,
          userId: true,
          accountId: true,
          version: true,
          requestedDate: true,
          requestedDateStr: true,
          status: true,
        },
      });
    } catch (err: any) {
      this.logger.warn(`Failed to query open bookings for auto-cancel: ${err.message}`);
      return { cancelledCount: 0, details };
    }

    let cancelledCount = 0;
    for (const b of openBookings) {
      const dateToCheck = b.requestedDateStr || b.requestedDate;
      if (isDateInPast(dateToCheck, todayIST)) {
        try {
          this.logger.log(
            `[AUTO-CANCEL] Darshan date ${b.requestedDateStr || b.requestedDate} is in the past (Today IST: ${todayIST}). Auto-cancelling booking #${b.bookingCode}`,
          );

          const reserveTxs = await this.prisma.walletTransaction.findMany({
            where: {
              bookingId: b.id,
              type: { in: ['RESERVE', 'RELEASE', 'CAPTURE', 'REFUND'] },
              status: 'COMPLETED',
            },
          });
          let currentHeld = 0;
          for (const tx of reserveTxs) {
            const amt = Number(tx.amount);
            if (tx.type === 'RESERVE') currentHeld += amt;
            if (tx.type === 'RELEASE' || tx.type === 'REFUND' || tx.type === 'CAPTURE') currentHeld -= amt;
          }

          if (currentHeld > 0) {
            await this.walletService
              .release({
                userId: b.userId,
                bookingId: b.id,
                amount: currentHeld,
                reason: `Auto-cancelled: Darshan date (${b.requestedDateStr || 'past'}) has passed`,
                idempotencyKey: `auto_cancel_${b.id}_v${b.version}_${Date.now()}`,
              })
              .catch((err) => {
                this.logger.warn(`Wallet release notice for #${b.bookingCode}: ${err.message}`);
              });
          }

          if (b.accountId) {
            await this.accountLockService.releaseLock(b.accountId, b.id).catch(() => {});
          }

          const cancelNow = new Date();
          const runAutoCancelTx = async (tx: any) => {
            if (this.stateMachine) {
              await this.stateMachine
                .transition({
                  bookingId: b.id,
                  targetStatus: BookingStatus.CANCELLED,
                  targetExecutionStatus: 'IDLE',
                  targetFinancialStatus: 'RELEASED',
                  expectedVersion: b.version,
                  note: `Auto-cancelled: Darshan date (${b.requestedDateStr || 'past date'}) has passed`,
                  reason: 'PAST_DATE_AUTO_CANCELLED',
                  milestone: 'PAST_DATE_AUTO_CANCELLED',
                  operator: 'BookingsService:autoCancelPastPendingBookings',
                  force: true,
                }, tx)
                .catch(async () => {
                  await tx.bookingRequest.update({
                    where: { id: b.id },
                    data: {
                      status: BookingStatus.CANCELLED,
                      assignedMachineId: null,
                      assignedMonitoringWorkerId: null,
                      isWatching: false,
                      monitoringStoppedAt: cancelNow,
                      leaseExpiresAt: null,
                      leaseStartedAt: null,
                    },
                  });
                });
            } else {
              await tx.bookingRequest.update({
                where: { id: b.id },
                data: {
                  status: BookingStatus.CANCELLED,
                  assignedMachineId: null,
                  assignedMonitoringWorkerId: null,
                  isWatching: false,
                  monitoringStoppedAt: cancelNow,
                  leaseExpiresAt: null,
                  leaseStartedAt: null,
                },
              });
            }

            await tx.bookingJob.updateMany({
              where: {
                bookingRequestId: b.id,
                status: {
                  notIn: [BookingStatus.SUCCESS, BookingStatus.COMPLETED, BookingStatus.CANCELLED, BookingStatus.FAILED],
                },
              },
              data: {
                status: BookingStatus.CANCELLED,
                workerId: null,
                leaseExpiresAt: null,
                completedAt: cancelNow,
              },
            });
          };

          if (typeof this.prisma.$transaction === 'function') {
            await this.prisma.$transaction(runAutoCancelTx);
          } else {
            await runAutoCancelTx(this.prisma);
          }

          this.eventsGateway.notifyBookingUpdated(b.id, b.userId, {
            bookingId: b.id,
            bookingCode: b.bookingCode,
            status: BookingStatus.CANCELLED,
            note: 'Auto-cancelled: Darshan date has passed',
            timestamp: new Date().toISOString(),
          });

          cancelledCount++;
          details.push(`Auto-cancelled past booking #${b.bookingCode} (date: ${b.requestedDateStr || 'past'})`);
        } catch (err: any) {
          this.logger.warn(`Failed to auto-cancel past booking #${b.bookingCode}: ${err.message}`);
        }
      }
    }

    return { cancelledCount, details };
  }

  /**
   * Get bookings list with role-based scoping and filters
   */
  async getBookings(user: any, query: { status?: BookingStatus; page?: number; limit?: number; search?: string }) {
    // Automatically cancel past-date pending bookings so user immediately sees them as cancelled and funds released
    try {
      await this.autoCancelPastPendingBookings(user.role === Role.CENTRE ? user.id : undefined);
    } catch (err: any) {
      this.logger.warn(`Auto-cancel check on getBookings error: ${err.message}`);
    }

    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;

    const andConditions: any[] = [];

    if (user.role === Role.CENTRE) {
      andConditions.push({ userId: user.id });
    } else if (user.role === Role.DISTRIBUTOR) {
      // By default, only show bookings made by this account. Use scope=network for full fleet.
      if ((query as any)?.scope === 'network') {
        const distributorId = user.distributorProfile?.id || user.distributorId;
        if (distributorId) {
          andConditions.push({
            OR: [
              { userId: user.id },
              { user: { distributorId } },
              { user: { centre: { distributorId } } },
            ],
          });
        } else {
          andConditions.push({ userId: user.id });
        }
      } else {
        andConditions.push({ userId: user.id });
      }
    } else if (user.role === Role.PARTNER) {
      if ((query as any)?.scope === 'network') {
        const partnerId = user.partnerProfile?.id || user.partnerId;
        if (partnerId) {
          andConditions.push({
            OR: [
              { user: { partnerId } },
              { user: { distributor: { partnerId } } },
              { user: { centre: { distributor: { partnerId } } } },
            ],
          });
        } else {
          andConditions.push({ userId: user.id });
        }
      } else {
        andConditions.push({ userId: user.id });
      }
    }

    if (query.status) {
      andConditions.push({ status: query.status });
    }
    if (query.search) {
      andConditions.push({
        OR: [
          { bookingCode: { contains: query.search, mode: 'insensitive' } },
          { route: { contains: query.search, mode: 'insensitive' } },
          { account: { username: { contains: query.search, mode: 'insensitive' } } },
          { account: { label: { contains: query.search, mode: 'insensitive' } } },
        ],
      });
    }

    const where: any = andConditions.length > 0 ? { AND: andConditions } : {};

    const [bookings, total] = await Promise.all([
      this.prisma.bookingRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          pilgrims: true,
          account: { select: { id: true, label: true, username: true, status: true } as any },
          confirmationHistory: true,
          assignedMachine: { select: { id: true, machineCode: true, machineName: true, status: true, lastHeartbeat: true, stopReason: true, stoppedAt: true } },
          monitoringWorker: { select: { id: true, machineCode: true, machineName: true, status: true, lastHeartbeat: true, stopReason: true, stoppedAt: true } },
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              mobile: true,
              role: true,
              partnerId: true,
              distributorId: true,
              centre: { select: { centreName: true, centreCode: true, district: true } },
            },
          },
        },
      }),
      this.prisma.bookingRequest.count({ where }),
    ]);

    return { bookings, total, page, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Get single booking details
   */
  async getBookingById(id: string, user: any) {
    const booking = await this.prisma.bookingRequest.findUnique({
      where: { id },
      include: {
        pilgrims: true,
        account: { select: { id: true, label: true, username: true, status: true } as any },
        confirmationHistory: true,
        assignedMachine: true,
        monitoringWorker: true,
        attempts: { orderBy: { startedAt: 'desc' } },
        jobs: { orderBy: { createdAt: 'desc' } },
        transactions: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            mobile: true,
            role: true,
            partnerId: true,
            distributorId: true,
            centre: {
              select: {
                id: true,
                centreName: true,
                centreCode: true,
                district: true,
                taluk: true,
                address: true,
                distributorId: true,
              },
            },
            distributor: {
              select: {
                id: true,
                distributorCode: true,
                name: true,
                partnerId: true,
              },
            },
          },
        },
      },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (user.role === Role.CENTRE && booking.userId !== user.id) {
      throw new ForbiddenException('Access denied to other centres booking data');
    }

    if (user.role === Role.DISTRIBUTOR) {
      const distributorId = user.distributorProfile?.id || user.distributorId;
      const isOwner = booking.userId === user.id;
      const isSubordinate = distributorId && (booking.user?.distributorId === distributorId || booking.user?.centre?.distributorId === distributorId);
      if (!isOwner && !isSubordinate) {
        throw new ForbiddenException('Access denied to bookings outside your authorized distributor network');
      }
    }

    if (user.role === Role.PARTNER) {
      const partnerId = user.partnerProfile?.id || user.partnerId;
      const isOwner = booking.userId === user.id;
      const isFranchiseBooking = partnerId && (
        booking.user?.partnerId === partnerId ||
        booking.user?.distributor?.partnerId === partnerId ||
        (booking.user?.centre as any)?.distributor?.partnerId === partnerId
      );
      if (!isOwner && !isFranchiseBooking) {
        throw new ForbiddenException('Access denied to bookings outside your authorized partner franchise');
      }
    }

    return booking;
  }

  /**
   * Cancel booking if not already finalized
   */
  async cancelBooking(id: string, user: any) {
    const booking = await this.prisma.bookingRequest.findUnique({
      where: { id },
      include: {
        user: {
          include: {
            centre: {
              include: { distributor: true },
            },
            distributor: true,
          },
        },
      },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (user.role === Role.CENTRE && booking.userId !== user.id) {
      throw new ForbiddenException('Access denied');
    }

    if (user.role === Role.DISTRIBUTOR) {
      const distributorId = user.distributorProfile?.id || user.distributorId;
      const isOwner = booking.userId === user.id;
      const isSubordinate = distributorId && (booking.user?.distributorId === distributorId || (booking.user as any)?.centre?.distributorId === distributorId);
      if (!isOwner && !isSubordinate) {
        throw new ForbiddenException('Access denied to bookings outside your authorized distributor network');
      }
    }

    if (user.role === Role.PARTNER) {
      const partnerId = user.partnerProfile?.id || user.partnerId;
      const isOwner = booking.userId === user.id;
      const isFranchise = partnerId && (
        booking.user?.partnerId === partnerId ||
        booking.user?.distributor?.partnerId === partnerId ||
        (booking.user?.centre as any)?.distributor?.partnerId === partnerId
      );
      if (!isOwner && !isFranchise) {
        throw new ForbiddenException('Access denied to bookings outside your authorized partner franchise');
      }
    }

    if (([BookingStatus.SUCCESS, BookingStatus.CANCELLED, BookingStatus.FAILED] as BookingStatus[]).includes(booking.status)) {
      throw new BadRequestException(`Cannot cancel booking in ${booking.status} state`);
    }

    // Find the exact active reserved amount for this booking
    const reserveTxs = await this.prisma.walletTransaction.findMany({
      where: {
        bookingId: booking.id,
        type: { in: ['RESERVE', 'RELEASE', 'CAPTURE', 'REFUND'] },
        status: 'COMPLETED',
      },
    });
    let currentHeld = 0;
    for (const tx of reserveTxs) {
      const amt = Number(tx.amount);
      if (tx.type === 'RESERVE') currentHeld += amt;
      if (tx.type === 'RELEASE' || tx.type === 'REFUND' || tx.type === 'CAPTURE') currentHeld -= amt;
    }
    const feeAmount = currentHeld > 0 ? currentHeld : 100;

    // Release funds and mark CANCELLED
    await this.walletService.release({
      userId: booking.userId,
      bookingId: booking.id,
      amount: feeAmount,
      reason: 'Cancelled by operator',
      idempotencyKey: `cancel_${booking.id}_v${booking.version}_${Date.now()}`,
    });

    if (booking.accountId) {
      await this.accountLockService.releaseLock(booking.accountId, booking.id);
    }

    const now = new Date();
    // Atomically transition booking to CANCELLED and close ALL open jobs in ONE transaction
    const updated = await this.prisma.$transaction(async (tx) => {
      const transitionRes = await this.stateMachine.transition({
        bookingId: id,
        targetStatus: BookingStatus.CANCELLED,
        targetExecutionStatus: 'IDLE',
        targetFinancialStatus: 'RELEASED',
        expectedVersion: booking.version,
        note: 'Cancelled by operator',
        force: user.role === Role.SUPER_ADMIN,
      }, tx);

      // Close ALL non-terminal jobs for this booking in the SAME transaction
      await tx.bookingJob.updateMany({
        where: {
          bookingRequestId: id,
          status: {
            notIn: [BookingStatus.SUCCESS, BookingStatus.COMPLETED, BookingStatus.CANCELLED, BookingStatus.FAILED],
          },
        },
        data: {
          status: BookingStatus.CANCELLED,
          workerId: null,
          leaseExpiresAt: null,
          completedAt: now,
        },
      });

      return transitionRes.booking;
    });

    return { message: 'Booking cancelled and funds released', booking: updated };
  }

  /**
   * Restart an individual failed or cancelled booking
   */
  async restartBooking(id: string, user: any) {
    const booking = await this.prisma.bookingRequest.findUnique({
      where: { id },
      include: {
        user: {
          include: {
            centre: {
              include: { distributor: true },
            },
            distributor: true,
          },
        },
      },
    });

    if (!booking) {
      throw new NotFoundException(`Booking #${id} not found`);
    }

    // Role-based authorization
    if (user.role === Role.CENTRE && booking.userId !== user.id) {
      throw new ForbiddenException('Access denied to other centres booking data');
    }

    if (user.role === Role.DISTRIBUTOR) {
      const distributorId = user.distributorProfile?.id || user.distributorId;
      const isOwner = booking.userId === user.id;
      const isSubordinate = distributorId && (booking.user?.distributorId === distributorId || (booking.user as any)?.centre?.distributorId === distributorId);
      if (!isOwner && !isSubordinate) {
        throw new ForbiddenException('Access denied to bookings outside your authorized distributor network');
      }
    }

    if (user.role === Role.PARTNER) {
      const partnerId = user.partnerProfile?.id || user.partnerId;
      const isOwner = booking.userId === user.id;
      const isFranchise = partnerId && (
        booking.user?.partnerId === partnerId ||
        booking.user?.distributor?.partnerId === partnerId ||
        (booking.user?.centre as any)?.distributor?.partnerId === partnerId
      );
      if (!isOwner && !isFranchise) {
        throw new ForbiddenException('Access denied to bookings outside your authorized partner franchise');
      }
    }

    // Do not restart if confirmed / completed
    if (
      ([BookingStatus.SUCCESS, BookingStatus.COMPLETED, BookingStatus.BOOKING_CONFIRMED] as BookingStatus[]).includes(booking.status) ||
      Boolean(booking.officialBookingReference || booking.officialReference)
    ) {
      throw new BadRequestException(`Cannot restart an already confirmed booking (#${booking.bookingCode})`);
    }

    // Only PENDING, CANCELLED, and FAILED bookings can be restarted
    const allowedRestartStatuses: BookingStatus[] = [
      BookingStatus.PENDING,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
      BookingStatus.LOGIN_FAILED,
      BookingStatus.SITE_ERROR,
      BookingStatus.WORKER_ERROR,
      BookingStatus.NO_AVAILABILITY,
      BookingStatus.DATE_UNAVAILABLE,
      BookingStatus.ROUTE_UNAVAILABLE,
      BookingStatus.EXPIRED,
      BookingStatus.TIMEOUT as any,
      BookingStatus.LOADER_TIMEOUT,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.HOLD_INVALID_NOMINEE,
      BookingStatus.DATE_SELECTION_FAILED,
      BookingStatus.DATE_VERIFICATION_FAILED,
      BookingStatus.PILGRIM_SELECTION_FAILED,
      BookingStatus.SUBMIT_FAILED,
      BookingStatus.WISHLIST_MISMATCH,
    ];
    if (!allowedRestartStatuses.includes(booking.status)) {
      throw new BadRequestException(
        `Only cancelled and failed bookings can be restarted. Booking #${booking.bookingCode} is in ${booking.status} state.`,
      );
    }

    // Reject restart if Darshan date has passed / finished
    const todayIST = getTodayISTDateString();
    const dateToCheck = booking.requestedDateStr || booking.requestedDate;
    if (isDateInPast(dateToCheck, todayIST)) {
      throw new BadRequestException(
        `Cannot restart booking #${booking.bookingCode} because the Darshan date (${booking.requestedDateStr || 'past'}) has already finished/passed. Only bookings with upcoming dates can be restarted.`,
      );
    }

    // Financial ledger check: determine if hold is active
    const reserveTxs = await this.prisma.walletTransaction.findMany({
      where: {
        bookingId: booking.id,
        type: { in: ['RESERVE', 'RELEASE', 'CAPTURE', 'REFUND'] },
        status: 'COMPLETED',
      },
    });

    let currentHeld = 0;
    for (const tx of reserveTxs) {
      const amt = Number(tx.amount);
      if (tx.type === 'RESERVE') currentHeld += amt;
      if (tx.type === 'RELEASE' || tx.type === 'REFUND' || tx.type === 'CAPTURE') currentHeld -= amt;
    }

    const lastReserve = [...reserveTxs].reverse().find((tx) => tx.type === 'RESERVE');
    const feeAmount = lastReserve
      ? Number(lastReserve.amount)
      : ((Number(booking.finalTicketPrice) || 20) * (booking.pilgrimCount || 1));

    // Safely release any stale execution lock held by this account or booking
    if (booking.accountId) {
      await this.accountLockService.releaseLock(booking.accountId, booking.bookingCode);
      await this.accountLockService.releaseLock(booking.accountId, booking.id);
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // If funds are not held (e.g. was cancelled and refunded), verify available balance and re-reserve
      if (currentHeld <= 0 && feeAmount > 0) {
        const wallet = await tx.wallet.findUnique({ where: { userId: booking.userId } });
        if (!wallet || Number(wallet.availableBalance) < feeAmount) {
          throw new BadRequestException(
            `Insufficient wallet balance to restart booking #${booking.bookingCode}. Required: ₹ ${feeAmount}, Available: ₹ ${wallet?.availableBalance || 0}`,
          );
        }

        await tx.wallet.update({
          where: { userId: booking.userId },
          data: {
            availableBalance: { decrement: feeAmount },
            reservedBalance: { increment: feeAmount },
          },
        });

        const newReserveTx = await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            userId: booking.userId,
            bookingId: booking.id,
            type: 'RESERVE',
            amount: new Prisma.Decimal(feeAmount),
            status: 'COMPLETED',
            reference: `RES-RESTART-${booking.bookingCode}-${Date.now().toString().slice(-4)}`,
            metadata: { bookingId: booking.id, restart: true },
          },
        });

        const txAny = tx as any;
        if (txAny.walletLedgerEntry) {
          await txAny.walletLedgerEntry.createMany({
            data: [
              {
                walletId: wallet.id,
                userId: booking.userId,
                bookingId: booking.id,
                transactionId: newReserveTx.id,
                account: 'CENTRE_AVAILABLE',
                entryType: 'DEBIT',
                amount: new Prisma.Decimal(feeAmount),
                reference: `LEDGER-RES-DEBIT-${booking.id.slice(0, 8)}`,
              },
              {
                walletId: wallet.id,
                userId: booking.userId,
                bookingId: booking.id,
                transactionId: newReserveTx.id,
                account: 'CENTRE_RESERVED',
                entryType: 'CREDIT',
                amount: new Prisma.Decimal(feeAmount),
                reference: `LEDGER-RES-CREDIT-${booking.id.slice(0, 8)}`,
              },
            ],
          });
        }
      }

      // Clear previous worker execution states, error states, and reset monitoring cycle on bookingRequest
      await tx.bookingRequest.update({
        where: { id },
        data: {
          assignedMachineId: null,
          assignedMonitoringWorkerId: null,
          monitoringAssignedAt: null,
          monitoringLeaseExpiresAt: null,
          isWatching: false,
          isManuallyAssigned: false,
          leaseExpiresAt: null,
          leaseStartedAt: null,
          failureReason: null,
          requiresHumanNote: null,
          lastRefreshResult: null,
          totalRefreshCount: 0,
          nextCheckAt: null,
          selectedTime: null,
        },
      });

      // Safely cancel any previous in-flight or non-terminal BookingJob to prevent premature execution
      // CRITICAL: Do NOT create or claim a booking execution job just because Restart was clicked.
      // Execution job will only be created when date availability is confirmed AVAILABLE by monitoring.
      await tx.bookingJob.updateMany({
        where: {
          bookingRequestId: booking.id,
          status: {
            notIn: [BookingStatus.SUCCESS, BookingStatus.COMPLETED, BookingStatus.CANCELLED],
          },
        },
        data: {
          status: BookingStatus.CANCELLED,
          workerId: null,
          leaseExpiresAt: null,
          leaseGeneration: { increment: 1 },
          leaseId: null,
          fencingToken: null,
          errorCode: null,
          errorMessage: null,
          completedAt: now,
        },
      });

      // Transition booking back to PENDING (initial clean restart state)
      const transitionRes = await this.stateMachine.transition(
        {
          bookingId: id,
          targetStatus: BookingStatus.PENDING,
          targetExecutionStatus: 'IDLE',
          targetFinancialStatus: 'RESERVED' as any,
          expectedVersion: booking.version,
          note: `Restarted by ${user.role} (${user.email || user.username || user.id}) - entered availability monitoring`,
          force: true,
        },
        tx,
      );

      // INSTANT WORKER ASSIGNMENT: immediately allocate to an online worker with monitoring capacity
      let instantWorker: any = null;
      if (this.smartAllocator && typeof this.smartAllocator.assignMonitoringWorkerInstantly === 'function') {
        try {
          const allocRes = await this.smartAllocator.assignMonitoringWorkerInstantly(id, tx);
          if (allocRes?.assigned && allocRes.worker) {
            instantWorker = allocRes.worker;
            await this.stateMachine.transition(
              {
                bookingId: id,
                targetStatus: BookingStatus.WATCHING,
                targetExecutionStatus: 'IDLE',
                expectedVersion: (transitionRes.booking?.version ?? booking.version) + 1,
                note: `Instantly assigned to worker ${allocRes.worker.machineCode} for availability monitoring`,
              },
              tx,
            ).catch(() => {});
          }
        } catch (allocErr: any) {
          this.logger.warn(`[BOOKING RESTART] Instant allocation notice for #${booking.bookingCode}: ${allocErr?.message || allocErr}`);
        }
      }

      return { booking: transitionRes.booking, instantWorker };
    });

    // If not instantly assigned, fall back to monitoring allocation sweep
    if (!updated?.instantWorker && this.smartAllocator) {
      try {
        await this.smartAllocator.runMonitoringAllocationSweep();
      } catch (allocErr: any) {
        this.logger.warn(`[BOOKING RESTART] Allocation sweep notice for #${booking.bookingCode}: ${allocErr?.message || allocErr}`);
      }
    }

    // Fetch updated booking with monitoring worker relation populated
    const freshBooking = await this.prisma.bookingRequest.findUnique({
      where: { id },
      include: {
        assignedMachine: { select: { id: true, machineCode: true, machineName: true, status: true } },
        monitoringWorker: { select: { id: true, machineCode: true, machineName: true, status: true } },
      },
    });

    this.eventsGateway.notifyBookingUpdated(booking.id, booking.userId, {
      bookingId: booking.id,
      bookingCode: booking.bookingCode,
      status: freshBooking?.status || BookingStatus.PENDING,
      assignedMonitoringWorkerId: freshBooking?.assignedMonitoringWorkerId || null,
      monitoringWorker: freshBooking?.monitoringWorker || null,
    });

    const isWatching = freshBooking?.status === BookingStatus.WATCHING;
    const workerCode = freshBooking?.monitoringWorker?.machineCode;

    this.logger.log(
      `[BOOKING RESTART] Booking #${booking.bookingCode} restarted by ${user.role} (Status: ${freshBooking?.status || 'PENDING'}, Assigned PC: ${workerCode || 'Pending Assignment'})`,
    );

    return {
      message: isWatching && workerCode
        ? `Booking #${booking.bookingCode} restarted and instantly assigned to worker ${workerCode} (Status: WATCHING)`
        : `Booking #${booking.bookingCode} restarted successfully and entered availability monitoring`,
      booking: freshBooking || updated?.booking || booking,
    };
  }

  /**
   * Restart all eligible failed, cancelled, or error bookings in bulk
   */
  async restartAllBookings(user: any, dto?: { bookingIds?: string[] }) {
    const where: Prisma.BookingRequestWhereInput = {};

    if (user.role === Role.CENTRE) {
      where.userId = user.id;
    } else if (user.role === Role.DISTRIBUTOR) {
      const distributorId = user.distributorProfile?.id || user.distributorId;
      where.OR = [
        { userId: user.id },
        { user: { distributorId } },
        { user: { centre: { distributorId } } },
      ];
    } else if (user.role === Role.PARTNER) {
      const partnerId = user.partnerProfile?.id || user.partnerId;
      where.OR = [
        { userId: user.id },
        { user: { partnerId } },
        { user: { distributor: { partnerId } } },
        { user: { centre: { distributor: { partnerId } } } },
      ];
    }

    // Only restart failed, cancelled, or error bookings (never confirmed/in-flight)
    const restartableStatuses: BookingStatus[] = [
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
      BookingStatus.LOGIN_FAILED,
      BookingStatus.SITE_ERROR,
      BookingStatus.WORKER_ERROR,
      BookingStatus.NO_AVAILABILITY,
      BookingStatus.DATE_UNAVAILABLE,
      BookingStatus.ROUTE_UNAVAILABLE,
      BookingStatus.EXPIRED,
      BookingStatus.TIMEOUT as any,
      BookingStatus.LOADER_TIMEOUT,
      BookingStatus.RETRYABLE_FAILURE,
      BookingStatus.HOLD_INVALID_NOMINEE,
      BookingStatus.DATE_SELECTION_FAILED,
      BookingStatus.DATE_VERIFICATION_FAILED,
      BookingStatus.PILGRIM_SELECTION_FAILED,
      BookingStatus.SUBMIT_FAILED,
      BookingStatus.WISHLIST_MISMATCH,
    ];

    where.status = { in: restartableStatuses };
    where.officialBookingReference = null;
    where.officialReference = null;

    if (dto?.bookingIds && dto.bookingIds.length > 0) {
      where.id = { in: dto.bookingIds };
    }

    const candidateBookings = await this.prisma.bookingRequest.findMany({
      where,
      select: {
        id: true,
        bookingCode: true,
        status: true,
        requestedDate: true,
        requestedDateStr: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (candidateBookings.length === 0) {
      return {
        message: 'No failed or cancelled bookings found to restart',
        total: 0,
        restarted: 0,
        skipped: 0,
        skippedReasons: [],
      };
    }

    let restartedCount = 0;
    let skippedCount = 0;
    const skippedReasons: string[] = [];
    const todayIST = getTodayISTDateString();

    for (const b of candidateBookings) {
      const dateToCheck = b.requestedDateStr || b.requestedDate;
      if (isDateInPast(dateToCheck, todayIST)) {
        skippedCount++;
        skippedReasons.push(`#${b.bookingCode}: Darshan date (${b.requestedDateStr || 'past'}) has passed`);
        continue;
      }

      try {
        await this.restartBooking(b.id, user);
        restartedCount++;
      } catch (err: any) {
        skippedCount++;
        skippedReasons.push(`#${b.bookingCode}: ${err.message}`);
      }
    }

    return {
      message: `Restart completed: ${restartedCount} booking(s) restarted, ${skippedCount} skipped.`,
      total: candidateBookings.length,
      restarted: restartedCount,
      skipped: skippedCount,
      skippedReasons,
    };
  }

  /**
   * Resolve a booking in REQUIRES_HUMAN state
   */
  async resolveHumanAction(id: string, dto: ResolveHumanActionDto, user: any) {
    const booking = await this.prisma.bookingRequest.findUnique({
      where: { id },
      include: {
        user: {
          include: {
            centre: {
              include: { distributor: true },
            },
            distributor: true,
          },
        },
      },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (user.role === Role.CENTRE && booking.userId !== user.id) {
      throw new ForbiddenException('Access denied to other centres booking data');
    }

    if (user.role === Role.DISTRIBUTOR) {
      const distributorId = user.distributorProfile?.id || user.distributorId;
      const isOwner = booking.userId === user.id;
      const isSubordinate = distributorId && (booking.user?.distributorId === distributorId || (booking.user as any)?.centre?.distributorId === distributorId);
      if (!isOwner && !isSubordinate) {
        throw new ForbiddenException('Access denied to bookings outside your authorized distributor network');
      }
    }

    if (user.role === Role.PARTNER) {
      const partnerId = user.partnerProfile?.id || user.partnerId;
      const isOwner = booking.userId === user.id;
      const isFranchise = partnerId && (
        booking.user?.partnerId === partnerId ||
        booking.user?.distributor?.partnerId === partnerId ||
        (booking.user?.centre as any)?.distributor?.partnerId === partnerId
      );
      if (!isOwner && !isFranchise) {
        throw new ForbiddenException('Access denied to bookings outside your authorized partner franchise');
      }
    }

    if (dto.action === 'SUCCESS_CONFIRMED') {
      const ref = (dto.officialBookingReference || dto.officialReference)?.trim();
      if (!ref || ref.length < 5 || ref.startsWith('SAB-2026-') || ref === 'SAB-2026-VERIFIED' || /^\d{8,12}$/.test(ref)) {
        throw new BadRequestException('Authoritative official booking reference (e.g. IVQ...) is required. Cart ID or synthetic references are rejected as booking references.');
      }

      const reserveTx = await this.prisma.walletTransaction.findFirst({
        where: {
          bookingId: booking.id,
          type: 'RESERVE',
          status: 'COMPLETED',
        },
      });
      const feeAmount = reserveTx ? Number(reserveTx.amount) : 100;

      await this.walletService.capture({
        userId: booking.userId,
        bookingId: booking.id,
        amount: feeAmount,
        workerMachineId: booking.assignedMachineId || undefined,
        idempotencyKey: `man_cap_${booking.id}`,
      });

      const transitionRes = await this.stateMachine.transition({
        bookingId: id,
        targetStatus: BookingStatus.SUCCESS,
        targetExecutionStatus: 'COMPLETED',
        targetFinancialStatus: 'CAPTURED',
        expectedVersion: booking.version,
        officialReference: ref,
        officialBookingReference: ref,
        cartId: dto.cartId,
        portalTransactionReference: dto.portalTransactionReference,
        confirmedAt: new Date(),
        note: dto.notes ? `Manually confirmed: ${dto.notes}` : 'Manually confirmed by operator',
      });
      const updated = transitionRes.booking;

      return { message: 'Booking manually confirmed and funds captured', booking: updated };
    } else if (dto.action === 'RETRY_QUEUE') {
      const transitionRes = await this.stateMachine.transition({
        bookingId: id,
        targetStatus: BookingStatus.QUEUED,
        targetExecutionStatus: 'ASSIGNED',
        expectedVersion: booking.version,
        note: 'Returned to queue by operator',
      });
      const updated = transitionRes.booking;

      // Reset or create retry job
      await this.prisma.bookingJob.upsert({
        where: {
          bookingRequestId: booking.id,
        },
        create: {
          jobType: JobType.BOOKING_EXECUTION,
          bookingRequestId: booking.id,
          accountId: booking.accountId,
          status: BookingStatus.QUEUED,
          workerId: null,
          leaseExpiresAt: null,
        },
        update: {
          jobType: JobType.BOOKING_EXECUTION,
          accountId: booking.accountId,
          status: BookingStatus.QUEUED,
          workerId: null,
          leaseExpiresAt: null,
          errorCode: null,
          errorMessage: null,
          completedAt: null,
        },
      });

      return { message: 'Booking returned to queue', booking: updated };
    } else {
      return this.cancelBooking(id, user);
    }
  }

  /**
   * Permanently delete a booking request and clean up associated records,
   * worker assignments, and release any active wallet holds.
   */
  async deleteBooking(id: string, user: any) {
    const booking = await this.prisma.bookingRequest.findUnique({
      where: { id },
      include: {
        user: {
          include: {
            centre: true,
          },
        },
      },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (user.role === Role.CENTRE && booking.userId !== user.id) {
      throw new ForbiddenException('Access denied: You can only delete your own bookings.');
    }

    // 1. Release any active wallet hold for this booking
    try {
      const reserveTxs = await this.prisma.walletTransaction.findMany({
        where: {
          bookingId: booking.id,
          type: { in: ['RESERVE', 'RELEASE', 'CAPTURE', 'REFUND'] },
          status: 'COMPLETED',
        },
      });
      let currentHeld = 0;
      for (const tx of reserveTxs) {
        const amt = Number(tx.amount);
        if (tx.type === 'RESERVE') currentHeld += amt;
        if (tx.type === 'RELEASE' || tx.type === 'REFUND' || tx.type === 'CAPTURE') currentHeld -= amt;
      }
      if (currentHeld > 0) {
        await this.walletService.release({
          userId: booking.userId,
          bookingId: booking.id,
          amount: currentHeld,
          reason: 'Booking deleted by operator',
          idempotencyKey: `delete_${booking.id}_${Date.now()}`,
        }).catch((err: any) => this.logger.warn(`Failed to release wallet hold on delete: ${err.message}`));
      }
    } catch (err: any) {
      this.logger.warn(`Error calculating held funds for deleted booking ${id}: ${err.message}`);
    }

    // 2. Release devotee account lock if held
    if (booking.accountId) {
      await this.accountLockService.releaseLock(booking.accountId, booking.id).catch(() => {});
    }

    // 3. If assigned to a worker that is actively running it, reset worker state
    const assignedExecutionWorkerId = booking.assignedMachineId;
    if (assignedExecutionWorkerId) {
      await this.prisma.workerMachine.updateMany({
        where: {
          id: assignedExecutionWorkerId,
          currentBookingId: booking.id,
        },
        data: {
          currentBookingId: null,
          currentJobId: null,
          currentActivity: 'IDLE',
          activityDetails: 'Idle, ready for work',
        },
      }).catch(() => {});
    }

    // 4. If assigned for monitoring, adjust cached count
    const assignedMonitoringId = booking.assignedMonitoringWorkerId;

    // 5. Unlink wallet transactions and ledger entries so they don't block deletion
    await this.prisma.walletTransaction.updateMany({
      where: { bookingId: booking.id },
      data: { bookingId: null },
    }).catch(() => {});
    await this.prisma.walletLedgerEntry.updateMany({
      where: { bookingId: booking.id },
      data: { bookingId: null },
    }).catch(() => {});

    // 6. Unlink availability opportunities
    await this.prisma.availabilityOpportunity.updateMany({
      where: { matchedBookingId: booking.id },
      data: { matchedBookingId: null },
    }).catch(() => {});

    // 7. Delete dependent logs & records
    await this.prisma.accountLock.deleteMany({
      where: { bookingId: booking.id },
    }).catch(() => {});
    await this.prisma.jobAllocationLog.deleteMany({
      where: { bookingId: booking.id },
    }).catch(() => {});
    await this.prisma.bookingMilestone.deleteMany({
      where: { bookingRequestId: booking.id },
    }).catch(() => {});
    await this.prisma.bookingAttempt.deleteMany({
      where: { bookingId: booking.id },
    }).catch(() => {});
    await this.prisma.bookingReconciliation.deleteMany({
      where: { bookingRequestId: booking.id },
    }).catch(() => {});
    await this.prisma.bookingJob.deleteMany({
      where: { bookingRequestId: booking.id },
    }).catch(() => {});
    await this.prisma.bookingPilgrim.deleteMany({
      where: { bookingRequestId: booking.id },
    }).catch(() => {});

    // 8. Delete the booking request
    await this.prisma.bookingRequest.delete({
      where: { id: booking.id },
    });

    if (assignedMonitoringId) {
      const remainingCount = await this.prisma.bookingRequest.count({
        where: {
          assignedMonitoringWorkerId: assignedMonitoringId,
          status: { in: [BookingStatus.PENDING, BookingStatus.WATCHING, BookingStatus.WAITING_FOR_DATE_AVAILABILITY, BookingStatus.FAST_BOOKING_QUEUED] },
        },
      }).catch(() => 0);
      await this.prisma.workerMachine.update({
        where: { id: assignedMonitoringId },
        data: { currentAssignedMonitoring: remainingCount },
      }).catch(() => {});
    }

    this.logger.log(`Booking #${booking.bookingCode} (ID: ${booking.id}) permanently deleted by ${user.role} (${user.email || user.id}).`);

    // 9. Audit log
    await this.audit.log({
      actorId: user.id,
      actorType: user.role === Role.SUPER_ADMIN ? 'ADMIN' : 'USER',
      action: 'BOOKING_DELETED',
      entity: 'BookingRequest',
      entityId: booking.id,
      metadata: {
        bookingCode: booking.bookingCode,
        requestedDate: booking.requestedDateStr || booking.requestedDate,
        route: booking.route,
        deletedByRole: user.role,
      },
    }).catch(() => {});

    // 10. Notify UI via WebSocket
    this.eventsGateway.emitToAdmins('admin:booking_deleted', { bookingId: booking.id, bookingCode: booking.bookingCode });
    this.eventsGateway.emitToAdmins('admin:booking_updated', { bookingId: booking.id, status: 'DELETED' });
    this.eventsGateway.notifyBookingUpdated(booking.id, booking.userId, {
      bookingId: booking.id,
      bookingCode: booking.bookingCode,
      status: 'DELETED',
      timestamp: new Date().toISOString(),
    });

    // 11. Proactively reconcile monitoring and allocation sweeps
    if (this.smartAllocator) {
      this.smartAllocator.runAllocationSweep().catch(() => {});
      this.smartAllocator.runMonitoringAllocationSweep().catch(() => {});
    }

    return {
      success: true,
      message: `Booking #${booking.bookingCode} was deleted successfully.`,
      bookingId: booking.id,
      bookingCode: booking.bookingCode,
    };
  }

  /**
   * Bulk delete multiple booking requests
   */
  async deleteBookings(ids: string[], user: any) {
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      throw new BadRequestException('No booking IDs provided');
    }
    const results: any[] = [];
    for (const id of ids) {
      try {
        const res = await this.deleteBooking(id, user);
        results.push(res);
      } catch (err: any) {
        this.logger.warn(`Failed to delete booking ${id}: ${err.message}`);
        results.push({ success: false, id, error: err.message });
      }
    }
    const deletedCount = results.filter((r) => r.success).length;
    return {
      success: true,
      message: `${deletedCount} of ${ids.length} booking(s) deleted successfully.`,
      deletedCount,
      results,
    };
  }

  /**
   * Generate guaranteed collision-proof, sequentially ascending booking codes (e.g. TA-10003).
   * Dynamically inspects the maximum existing numeric suffix and checks existence within the transaction
   * to prevent collisions even when prior rows have been deleted or when IDs have gaps.
   */
  private async generateUniqueBookingCode(tx: any): Promise<string> {
    const totalCount = typeof tx?.bookingRequest?.count === 'function'
      ? await tx.bookingRequest.count()
      : (typeof this.prisma?.bookingRequest?.count === 'function' ? await this.prisma.bookingRequest.count() : 0);

    let recentBookings: Array<{ bookingCode?: string | null }> = [];
    if (typeof tx?.bookingRequest?.findMany === 'function') {
      recentBookings = await tx.bookingRequest.findMany({
        where: { bookingCode: { startsWith: 'TA-' } },
        select: { bookingCode: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
    } else if (typeof this.prisma?.bookingRequest?.findMany === 'function') {
      recentBookings = await this.prisma.bookingRequest.findMany({
        where: { bookingCode: { startsWith: 'TA-' } },
        select: { bookingCode: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
    }

    let maxNum = Math.max(10000, 10000 + (Number(totalCount) || 0));
    if (Array.isArray(recentBookings)) {
      for (const b of recentBookings) {
        const match = String(b?.bookingCode || '').match(/^TA-(\d+)$/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (!isNaN(num) && num > maxNum) {
            maxNum = num;
          }
        }
      }
    }

    let candidateNum = maxNum + 1;
    let candidateCode = `TA-${candidateNum}`;

    const checkExists = async (code: string): Promise<boolean> => {
      if (typeof tx?.bookingRequest?.findUnique === 'function') {
        const found = await tx.bookingRequest.findUnique({
          where: { bookingCode: code },
          select: { id: true },
        });
        return !!found;
      }
      if (typeof tx?.bookingRequest?.findFirst === 'function') {
        const found = await tx.bookingRequest.findFirst({
          where: { bookingCode: code },
          select: { id: true },
        });
        return !!found;
      }
      return false;
    };

    while (await checkExists(candidateCode)) {
      candidateNum++;
      candidateCode = `TA-${candidateNum}`;
    }

    return candidateCode;
  }

  /**
   * Get public/centre system booking configuration & pricing
   */
  async getBookingConfig() {
    const config = await this.prisma.systemConfig.findUnique({
      where: { id: 'default' },
    });
    return {
      serviceFee: Number(config?.serviceFee ?? 20),
      registrationFee: Number(config?.registrationFee || 249),
      accountValidityDays: config?.accountValidityDays || 365,
      checkingIntervalSeconds: config?.checkingIntervalSeconds || 300,
    };
  }

  /**
   * Super Admin action: Manually complete an individual devotee.
   * Devotee is assigned status ADMIN_COMPLETED.
   * If all requested devotees are completed/confirmed, the parent booking transitions to completed.
   * Otherwise, the parent booking remains active in WATCHING with PARTIALLY_CONFIRMED.
   */
  async completePilgrimManually(
    adminUser: any,
    bookingId: string,
    pilgrimId: string,
    dto: { reason: string },
  ) {
    if (adminUser.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Only Super Admin is permitted to manually mark devotees as completed.');
    }

    const reason = dto?.reason?.trim();
    if (!reason) {
      throw new BadRequestException('A valid administrative reason is required for manual devotee completion.');
    }

    const booking = await this.prisma.bookingRequest.findUnique({
      where: { id: bookingId },
      include: {
        pilgrims: true,
        jobs: true,
      },
    });

    if (!booking) {
      throw new NotFoundException(`Booking with ID ${bookingId} not found.`);
    }

    const pilgrim = booking.pilgrims.find((p) => p.id === pilgrimId);
    if (!pilgrim) {
      throw new NotFoundException(`Devotee with ID ${pilgrimId} not found on booking #${booking.bookingCode}.`);
    }

    const currentMeta = typeof pilgrim.metadata === 'string'
      ? JSON.parse(pilgrim.metadata)
      : (pilgrim.metadata || {});

    if (
      currentMeta.taskStatus === 'CONFIRMED' ||
      currentMeta.taskStatus === 'ADMIN_COMPLETED' ||
      currentMeta.status === 'CONFIRMED' ||
      currentMeta.status === 'ADMIN_COMPLETED' ||
      currentMeta.officialBookingReference
    ) {
      throw new BadRequestException(`Devotee ${pilgrim.fullName} is already marked as confirmed or completed.`);
    }

    const now = new Date();
    const updatedMeta = {
      ...currentMeta,
      taskStatus: 'ADMIN_COMPLETED',
      status: 'ADMIN_COMPLETED',
      completedByAdminId: adminUser.id,
      completedByAdminName: adminUser.name || adminUser.email || 'Super Admin',
      adminReason: reason,
      completedAt: now.toISOString(),
    };

    const totalRequested = Math.max(1, booking.pilgrimCount || booking.pilgrims.length || 1);

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Update the pilgrim's metadata
      const updatedPilgrim = await tx.bookingPilgrim.update({
        where: { id: pilgrimId },
        data: {
          metadata: updatedMeta,
        },
      });

      // 2. Count completed devotees
      const allPilgrims = await tx.bookingPilgrim.findMany({
        where: { bookingRequestId: bookingId },
      });

      const completedDevotees = allPilgrims.filter((p) => {
        const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : (p.metadata || {});
        return (
          m.taskStatus === 'CONFIRMED' ||
          m.taskStatus === 'ADMIN_COMPLETED' ||
          m.status === 'CONFIRMED' ||
          m.status === 'ADMIN_COMPLETED' ||
          !!m.officialBookingReference ||
          !!m.portalTransactionReference ||
          !!m.transactionId ||
          p.id === pilgrimId
        );
      });

      const completedCount = completedDevotees.length;
      const isAllDone = completedCount >= totalRequested;
      const remainingCount = Math.max(0, totalRequested - completedCount);

      let authoritativeRef: string | null = null;
      if (isAllDone) {
        // Find existing authoritative portal reference if any, or retain existing
        const portalRef = allPilgrims.find((p) => {
          const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : (p.metadata || {});
          return m.officialBookingReference || m.portalTransactionReference || m.transactionId;
        });
        const portalMeta = portalRef ? (typeof portalRef.metadata === 'string' ? JSON.parse(portalRef.metadata) : (portalRef.metadata || {})) : {};
        authoritativeRef = portalMeta.officialBookingReference ||
          portalMeta.portalTransactionReference ||
          portalMeta.transactionId ||
          booking.portalTransactionReference ||
          booking.officialBookingReference ||
          booking.officialReference ||
          null;

        // Complete any open booking jobs
        await tx.bookingJob.updateMany({
          where: { bookingRequestId: bookingId, status: { notIn: [BookingStatus.SUCCESS, BookingStatus.CANCELLED] } },
          data: { status: BookingStatus.SUCCESS, leaseExpiresAt: null, completedAt: now },
        });

        // Wallet capture if reserve transaction exists and not yet captured
        if (this.walletService) {
          try {
            const reserveTx = await tx.walletTransaction.findFirst({
              where: { bookingId: booking.id, type: 'RESERVE', status: 'COMPLETED' },
            });
            const feeAmount = reserveTx ? Number(reserveTx.amount) : 10;
            await this.walletService.capture({
              userId: booking.userId,
              bookingId: booking.id,
              amount: feeAmount,
              idempotencyKey: `adm_cap_${booking.id}`,
            }, tx);
          } catch (e: any) {
            this.logger.warn(`Wallet capture during admin completion: ${e.message}`);
          }
        }

        if (this.stateMachine) {
          try {
            await this.stateMachine.transition({
              bookingId: booking.id,
              targetStatus: BookingStatus.SUCCESS,
              targetExecutionStatus: 'COMPLETED',
              targetFinancialStatus: 'CAPTURED',
              milestone: 'ALL_DEVOTEES_COMPLETED',
              officialReference: authoritativeRef,
              officialBookingReference: authoritativeRef,
              portalTransactionReference: authoritativeRef,
              confirmedAt: now,
              note: `All ${totalRequested} devotees completed (${completedCount - 1} confirmed, 1 admin completed by Super Admin: ${reason})`,
              force: true,
            }, tx);
          } catch (smErr: any) {
            this.logger.warn(`State machine transition notice during admin completion: ${smErr.message}`);
          }
        }

        // Atomically guarantee BookingRequest is marked SUCCESS, isWatching is false, and reconciliationStatus is cleared
        await tx.bookingRequest.update({
          where: { id: booking.id },
          data: {
            status: BookingStatus.SUCCESS,
            executionStatus: 'COMPLETED',
            financialStatus: 'CAPTURED',
            isWatching: false,
            reconciliationStatus: null,
            lastMilestone: `COMPLETED (${totalRequested}/${totalRequested} Devotees)`,
            completedAt: now,
            confirmedAt: booking.confirmedAt || now,
            portalTransactionReference: authoritativeRef || booking.portalTransactionReference,
            officialBookingReference: authoritativeRef || booking.officialBookingReference,
            officialReference: authoritativeRef || booking.officialReference,
            assignedMachineId: null,
            assignedMonitoringWorkerId: null,
            monitoringStoppedAt: now,
            leaseExpiresAt: null,
          },
        });
      } else {
        // Multi-devotee booking: remains active in WATCHING with PARTIALLY_CONFIRMED
        await tx.bookingRequest.update({
          where: { id: booking.id },
          data: {
            status: BookingStatus.WATCHING,
            isWatching: true,
            reconciliationStatus: 'PARTIALLY_CONFIRMED',
            lastMilestone: `PARTIALLY_CONFIRMED (${completedCount}/${totalRequested} Completed, ${remainingCount} Pending)`,
          },
        });

        // Reset booking job to QUEUED so next devotee can be allocated
        await tx.bookingJob.updateMany({
          where: { bookingRequestId: bookingId, status: { notIn: [BookingStatus.SUCCESS, BookingStatus.CANCELLED] } },
          data: {
            status: BookingStatus.QUEUED,
            workerId: null,
            leaseExpiresAt: null,
            attempt: 0,
          },
        });
      }

      return {
        updatedPilgrim,
        completedCount,
        totalRequested,
        remainingCount,
        isAllDone,
        authoritativeRef,
      };
    });

    // 3. Log audit event
    await this.audit.log({
      actorId: adminUser.id,
      actorType: 'ADMIN',
      action: 'ADMIN_MANUAL_DEVOTEE_COMPLETED',
      entity: 'BookingPilgrim',
      entityId: pilgrimId,
      metadata: {
        bookingId,
        bookingCode: booking.bookingCode,
        devoteeName: pilgrim.fullName,
        reason,
        completedCount: result.completedCount,
        totalRequested: result.totalRequested,
        isAllDone: result.isAllDone,
      },
    });

    // If remaining devotees still pending, immediately trigger worker allocation/monitoring refresh
    if (!result.isAllDone && this.smartAllocator) {
      try {
        if (typeof this.smartAllocator.assignMonitoringWorkerInstantly === 'function') {
          await this.smartAllocator.assignMonitoringWorkerInstantly(bookingId).catch(() => {});
        }
        await this.smartAllocator.runMonitoringAllocationSweep().catch(() => {});
      } catch (allocErr: any) {
        this.logger.warn(`Allocation notice after manual devotee completion: ${allocErr?.message || allocErr}`);
      }
    }

    // 4. Broadcast events to both Centre users and Super Admins
    if (this.eventsGateway) {
      try {
        if (result.isAllDone) {
          this.eventsGateway.notifyBookingConfirmed({
            bookingId: booking.id,
            userId: booking.userId,
            bookingCode: booking.bookingCode,
            status: BookingStatus.SUCCESS,
            route: booking.route,
            requestedDate: booking.requestedDate,
            officialReference: result.authoritativeRef || booking.officialReference,
          });
          this.eventsGateway.notifyBookingUpdated(booking.id, booking.userId, {
            bookingId: booking.id,
            userId: booking.userId,
            bookingCode: booking.bookingCode,
            status: BookingStatus.SUCCESS,
            executionStatus: 'COMPLETED',
            reconciliationStatus: null,
            officialReference: result.authoritativeRef || booking.officialReference,
            portalTransactionReference: result.authoritativeRef || booking.portalTransactionReference,
            lastMilestone: `COMPLETED (${result.totalRequested}/${result.totalRequested} Devotees)`,
            confirmedCount: result.totalRequested,
            totalRequested: result.totalRequested,
            remainingCount: 0,
            isCompleted: true,
          });
          if (typeof (this.eventsGateway as any).emitToAdmins === 'function') {
            (this.eventsGateway as any).emitToAdmins('admin:booking_updated', {
              bookingId: booking.id,
              bookingCode: booking.bookingCode,
              status: BookingStatus.SUCCESS,
              executionStatus: 'COMPLETED',
              reconciliationStatus: null,
              officialReference: result.authoritativeRef || booking.officialReference,
              portalTransactionReference: result.authoritativeRef || booking.portalTransactionReference,
              confirmedCount: result.totalRequested,
              totalRequested: result.totalRequested,
              remainingCount: 0,
              isCompleted: true,
            });
          }
        } else {
          this.eventsGateway.notifyBookingUpdated(booking.id, booking.userId, {
            bookingId: booking.id,
            userId: booking.userId,
            bookingCode: booking.bookingCode,
            status: BookingStatus.WATCHING,
            reconciliationStatus: 'PARTIALLY_CONFIRMED',
            lastMilestone: `PARTIALLY_CONFIRMED (${result.completedCount}/${result.totalRequested} Completed, ${result.remainingCount} Pending)`,
            confirmedCount: result.completedCount,
            totalRequested: result.totalRequested,
            remainingCount: result.remainingCount,
          });
          if (typeof (this.eventsGateway as any).emitToAdmins === 'function') {
            (this.eventsGateway as any).emitToAdmins('admin:booking_updated', {
              bookingId: booking.id,
              bookingCode: booking.bookingCode,
              status: BookingStatus.WATCHING,
              reconciliationStatus: 'PARTIALLY_CONFIRMED',
              confirmedCount: result.completedCount,
              totalRequested: result.totalRequested,
              remainingCount: result.remainingCount,
              isCompleted: false,
            });
          }
        }
      } catch (wsErr: any) {
        this.logger.warn(`WebSocket notification failed: ${wsErr.message}`);
      }
    }

    return {
      success: true,
      message: `Devotee ${pilgrim.fullName} successfully marked as completed.`,
      pilgrim: result.updatedPilgrim,
      isAllDone: result.isAllDone,
      progress: {
        completedCount: result.completedCount,
        totalRequested: result.totalRequested,
        remainingCount: result.remainingCount,
      },
    };
  }
}
