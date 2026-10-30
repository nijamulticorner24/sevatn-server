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

import { EventsGateway } from '../events/events.gateway';
import { SmartAllocatorService } from '../workers/smart-allocator.service';
import { BookingStateMachineService } from './booking-state-machine.service';
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

    // 1. Optional Pilgrim Details Validation (if explicitly supplied)
    if (dto.pilgrims && Array.isArray(dto.pilgrims) && dto.pilgrims.length > 0) {
      if (dto.pilgrims.length > 10) {
        throw new BadRequestException('A maximum of 10 pilgrims is permitted per booking.');
      }

      for (let i = 0; i < dto.pilgrims.length; i++) {
        const p = dto.pilgrims[i];
        if (!p.fullName || p.fullName.trim().length < 2) {
          throw new BadRequestException(`Pilgrim #${i + 1}: Full name is required.`);
        }
        if (!p.age || typeof p.age !== 'number' || p.age < 1 || p.age > 120) {
          throw new BadRequestException(`Pilgrim #${i + 1}: Valid age between 1 and 120 is required.`);
        }
        if (!p.gender || !['MALE', 'FEMALE', 'TRANSGENDER'].includes(p.gender.toUpperCase())) {
          throw new BadRequestException(`Pilgrim #${i + 1}: Valid gender (MALE, FEMALE, TRANSGENDER) is required.`);
        }
        if (!p.idType || !['AADHAAR', 'VOTER_ID', 'PASSPORT'].includes(p.idType.toUpperCase())) {
          throw new BadRequestException(`Pilgrim #${i + 1}: Valid ID type (AADHAAR, VOTER_ID, PASSPORT) is required.`);
        }
        if (!p.idNumber || p.idNumber.trim().length < 4) {
          throw new BadRequestException(`Pilgrim #${i + 1}: Valid ID number is required.`);
        }
      }
    }

    // 2. Mandatory Nominee Validation (Required for Pilgrim Insurance)
    const resolvedNominee = (dto.nominees && dto.nominees[0]) || dto.nominee || (dto.nomineeName ? {
      nomineeName: dto.nomineeName,
      nomineeAge: dto.nomineeAge,
      nomineeRelationship: dto.nomineeRelationship,
      nomineePhone: dto.nomineePhone,
    } : null) || (dto.pilgrims && dto.pilgrims[0]?.nominee ? dto.pilgrims[0].nominee : null) || (dto.pilgrims && dto.pilgrims[0]?.nomineeName ? {
      nomineeName: dto.pilgrims[0].nomineeName,
      nomineeAge: dto.pilgrims[0].nomineeAge,
      nomineeRelationship: dto.pilgrims[0].nomineeRelationship,
      nomineePhone: dto.pilgrims[0].nomineePhone,
    } : null);

    if (!resolvedNominee || !resolvedNominee.nomineeName || resolvedNominee.nomineeName.trim().length < 2) {
      throw new BadRequestException('Nominee name is required for pilgrim insurance.');
    }
    if (!resolvedNominee.nomineeAge || typeof resolvedNominee.nomineeAge !== 'number' || resolvedNominee.nomineeAge < 18 || resolvedNominee.nomineeAge > 120) {
      throw new BadRequestException('Nominee must be an adult with a valid age (minimum 18 years).');
    }
    if (!resolvedNominee.nomineeRelationship || resolvedNominee.nomineeRelationship.trim().length < 2) {
      throw new BadRequestException('Nominee relationship is required.');
    }

    if (dto.nominees && Array.isArray(dto.nominees)) {
      for (let i = 0; i < dto.nominees.length; i++) {
        const n = dto.nominees[i];
        if (!n.nomineeName || n.nomineeName.trim().length < 2) {
          throw new BadRequestException(`Nominee #${i + 1}: Name is required.`);
        }
        if (!n.nomineeAge || typeof n.nomineeAge !== 'number' || n.nomineeAge < 18 || n.nomineeAge > 120) {
          throw new BadRequestException(`Nominee #${i + 1}: Must be an adult (minimum 18 years).`);
        }
        if (!n.nomineeRelationship || n.nomineeRelationship.trim().length < 2) {
          throw new BadRequestException(`Nominee #${i + 1}: Relationship is required.`);
        }
      }
    }

    // Verify user role
    const callingUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    const isSuperAdmin = callingUser?.role === Role.SUPER_ADMIN;

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
      if (existingAccount.userId !== userId && !isSuperAdmin) {
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

    // Generate readable booking code e.g. TA-10492
    const count = await this.prisma.bookingRequest.count();
    const bookingCode = `TA-${10000 + count + 1}`;

    const rawDateStr = dto.requestedDate.split('T')[0];
    const [year, month, day] = rawDateStr.split('-').map(Number);
    const canonicalDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));

    const config = await this.prisma.systemConfig.findUnique({
      where: { id: 'default' },
    });
    const feeAmount = Number(config?.serviceFee ?? 20);

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Verify and reserve funds from wallet (Super Admin auto-funded/exempted)
      let wallet = await tx.wallet.findUnique({ where: { userId } });

      if (isSuperAdmin) {
        if (!wallet) {
          wallet = await tx.wallet.create({
            data: {
              userId,
              availableBalance: new Prisma.Decimal(999999),
              reservedBalance: new Prisma.Decimal(0),
            },
          });
        } else if (Number(wallet.availableBalance) < feeAmount) {
          wallet = await tx.wallet.update({
            where: { userId },
            data: {
              availableBalance: { increment: 100000 },
            },
          });
        }
      }

      if (!wallet || Number(wallet.availableBalance) < feeAmount) {
        throw new BadRequestException(
          `Insufficient wallet balance. Required: ₹${feeAmount}, Available: ₹${wallet?.availableBalance || 0}`,
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
        const availableOpp = await tx.availabilityOpportunity.findFirst({
          where: {
            date: rawDateStr,
            route: {
              contains: dto.route.split(' ')[0],
              mode: 'insensitive',
            },
            status: 'AVAILABLE',
          },
        });

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
          route: dto.route,
          pilgrimCount: (dto.pilgrims && dto.pilgrims.length > 0) ? dto.pilgrims.length : 1,
          timeSlot: dto.timeSlot || 'Any Slot',
          selectedTime: matchedTimeSlot || undefined,
          nomineeName: resolvedNominee.nomineeName.trim(),
          nomineeAge: resolvedNominee.nomineeAge,
          nomineeRelationship: resolvedNominee.nomineeRelationship.trim(),
          nomineePhone: resolvedNominee.nomineePhone?.trim() || null,
          preferences: {
            ...(dto.preferences || {}),
            nominees: dto.nominees || (resolvedNominee ? [resolvedNominee] : []),
            termsAccepted: true,
            termsAcceptedAt: new Date().toISOString(),
          },
          status: initialStatus,
          pilgrims: (dto.pilgrims && dto.pilgrims.length > 0) ? {
            create: dto.pilgrims.map((p) => ({
              fullName: p.fullName.trim(),
              age: p.age,
              gender: p.gender.toUpperCase(),
              idType: p.idType.toUpperCase(),
              idNumber: p.idNumber.trim(),
              photoUrl: p.photoUrl || null,
              nomineeName: (p.nomineeName || resolvedNominee.nomineeName).trim(),
              nomineeAge: p.nomineeAge || resolvedNominee.nomineeAge,
              nomineeRelationship: (p.nomineeRelationship || resolvedNominee.nomineeRelationship).trim(),
              nomineePhone: p.nomineePhone?.trim() || resolvedNominee.nomineePhone?.trim() || null,
            })),
          } : undefined,
        } as any,
        include: {
          pilgrims: true,
          account: { select: { id: true, username: true, status: true } },
        },
      });

      // 5. Create BOOKING_EXECUTION job ONLY if date is available and account is verified
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
      } else {
        this.logger.log(`[BOOKING] Waiting in availability queue (PENDING) for date: ${rawDateStr} #${booking.bookingCode}`);
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
      this.smartAllocator.runAllocationSweep().catch((err) => {
        this.logger.warn(`Proactive allocation error: ${err.message}`);
      });
    }

    return result;
  }

  /**
   * Get bookings list with role-based scoping and filters
   */
  async getBookings(user: any, query: { status?: BookingStatus; page?: number; limit?: number; search?: string }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (user.role === Role.CENTRE) {
      where.userId = user.id;
    } else if (user.role === Role.PARTNER) {
      const partnerId = user.partnerProfile?.id || user.partnerId;
      if (partnerId) {
        where.user = { partnerId };
      } else {
        where.userId = user.id;
      }
    }

    if (query.status) {
      where.status = query.status;
    }
    if (query.search) {
      where.OR = [
        { bookingCode: { contains: query.search, mode: 'insensitive' } },
        { route: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [bookings, total] = await Promise.all([
      this.prisma.bookingRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          pilgrims: true,
          account: { select: { id: true, label: true, username: true, status: true } as any },
          assignedMachine: { select: { machineCode: true, machineName: true, status: true } },
          user: { select: { name: true, email: true, mobile: true, partnerId: true, centre: { select: { centreName: true, district: true } } } },
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
        assignedMachine: true,
        attempts: { orderBy: { startedAt: 'desc' } },
        jobs: { orderBy: { createdAt: 'desc' } },
        transactions: true,
        user: { include: { centre: true } },
      },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (user.role === Role.CENTRE && booking.userId !== user.id) {
      throw new ForbiddenException('Access denied to other centres booking data');
    }

    if (user.role === Role.PARTNER) {
      const partnerId = user.partnerProfile?.id || user.partnerId;
      if (!partnerId || booking.user?.partnerId !== partnerId) {
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
      include: { user: true },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (user.role === Role.CENTRE && booking.userId !== user.id) {
      throw new ForbiddenException('Access denied');
    }

    if (user.role === Role.PARTNER) {
      const partnerId = user.partnerProfile?.id || user.partnerId;
      if (!partnerId || booking.user?.partnerId !== partnerId) {
        throw new ForbiddenException('Access denied to bookings outside your authorized partner franchise');
      }
    }

    if (([BookingStatus.SUCCESS, BookingStatus.CANCELLED, BookingStatus.FAILED] as BookingStatus[]).includes(booking.status)) {
      throw new BadRequestException(`Cannot cancel booking in ${booking.status} state`);
    }

    // Find the exact reserved amount for this booking
    const reserveTx = await this.prisma.walletTransaction.findFirst({
      where: {
        bookingId: booking.id,
        type: 'RESERVE',
        status: 'COMPLETED',
      },
    });
    const feeAmount = reserveTx ? Number(reserveTx.amount) : 100;

    // Release funds and mark CANCELLED
    await this.walletService.release({
      userId: booking.userId,
      bookingId: booking.id,
      amount: feeAmount,
      reason: 'Cancelled by operator',
      idempotencyKey: `cancel_${booking.id}`,
    });

    if (booking.accountId) {
      await this.accountLockService.releaseLock(booking.accountId, booking.id);
    }

    const transitionRes = await this.stateMachine.transition({
      bookingId: id,
      targetStatus: BookingStatus.CANCELLED,
      targetExecutionStatus: 'IDLE',
      targetFinancialStatus: 'RELEASED',
      expectedVersion: booking.version,
      note: 'Cancelled by operator',
      force: user.role === Role.SUPER_ADMIN,
    });
    const updated = transitionRes.booking;

    // Also cancel any pending or errored jobs
    await this.prisma.bookingJob.updateMany({
      where: {
        bookingRequestId: id,
        status: { in: [
          BookingStatus.QUEUED,
          BookingStatus.WORKER_ASSIGNED,
          BookingStatus.CHECKING_AVAILABILITY,
          BookingStatus.WATCHING,
          BookingStatus.CLAIMED,
          BookingStatus.EXECUTING,
          BookingStatus.WORKER_ERROR,
          BookingStatus.HOLD_INVALID_NOMINEE,
        ] },
      },
      data: { status: BookingStatus.CANCELLED },
    });

    return { message: 'Booking cancelled and funds released', booking: updated };
  }

  /**
   * Resolve a booking in REQUIRES_HUMAN state
   */
  async resolveHumanAction(id: string, dto: ResolveHumanActionDto, user: any) {
    const booking = await this.prisma.bookingRequest.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (user.role === Role.CENTRE && booking.userId !== user.id) {
      throw new ForbiddenException('Access denied to other centres booking data');
    }

    if (user.role === Role.PARTNER) {
      const partnerId = user.partnerProfile?.id || user.partnerId;
      if (!partnerId || booking.user?.partnerId !== partnerId) {
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

      // Create new retry job
      await this.prisma.bookingJob.create({
        data: {
          jobType: JobType.BOOKING_EXECUTION,
          bookingRequestId: booking.id,
          accountId: booking.accountId,
          status: BookingStatus.QUEUED,
        },
      });

      return { message: 'Booking returned to queue', booking: updated };
    } else {
      return this.cancelBooking(id, user);
    }
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
}
