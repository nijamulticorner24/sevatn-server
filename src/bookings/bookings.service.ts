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
import { BookingStatus, JobType, AccountStatus, Role } from '@prisma/client';

import { EventsGateway } from '../events/events.gateway';

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
  ) {}

  /**
   * Create a new official Sabarimala booking request (Date demand registered in PENDING state)
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
      // 1. Verify and reserve funds from wallet
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet || Number(wallet.availableBalance) < feeAmount) {
        throw new BadRequestException(
          `Insufficient wallet balance. Required: ₹${feeAmount}, Available: ₹${wallet?.availableBalance || 0}`,
        );
      }

      // 2. Handle Official Devotee Account credentials
      let accountId = dto.accountId;

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
      }

      // 3. Create Booking Request in AVAILABILITY_CHECKING state
      const booking = await tx.bookingRequest.create({
        data: {
          bookingCode,
          userId,
          accountId: accountId || null,
          requestedDate: canonicalDate,
          requestedDateStr: rawDateStr,
          route: dto.route,
          pilgrimCount: dto.pilgrims?.length || 1,
          timeSlot: dto.timeSlot || 'Any Slot',
          preferences: {
            ...(dto.preferences || {}),
            termsAccepted: true,
            termsAcceptedAt: new Date().toISOString(),
          },
          status: BookingStatus.AVAILABILITY_CHECKING,
          pilgrims: dto.pilgrims && dto.pilgrims.length > 0
            ? {
                create: dto.pilgrims.map((p) => ({
                  fullName: p.fullName,
                  age: p.age,
                  gender: p.gender,
                  idType: p.idType,
                  idNumber: p.idNumber,
                  photoUrl: p.photoUrl,
                })),
              }
            : undefined,
        },
        include: {
          pilgrims: true,
          account: { select: { id: true, username: true, status: true } },
        },
      });

      // 4. Create immediate BookingJob for worker immediate availability check & fast booking
      await tx.bookingJob.create({
        data: {
          jobType: JobType.BOOKING_EXECUTION,
          bookingRequestId: booking.id,
          accountId: accountId || null,
          status: BookingStatus.QUEUED,
        },
      });

      // 5. Reserve configured service fee in wallet hold ledger
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

      this.logger.log(`[BOOKING] New request: #${booking.bookingCode}`);

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
          user: { select: { name: true, email: true, mobile: true, centre: { select: { centreName: true, district: true } } } },
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

    return booking;
  }

  /**
   * Cancel booking if not already finalized
   */
  async cancelBooking(id: string, user: any) {
    const booking = await this.prisma.bookingRequest.findUnique({
      where: { id },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (user.role === Role.CENTRE && booking.userId !== user.id) {
      throw new ForbiddenException('Access denied');
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

    const updated = await this.prisma.bookingRequest.update({
      where: { id },
      data: {
        status: BookingStatus.CANCELLED,
        assignedMachineId: null,
      },
    });

    // Also cancel any pending jobs
    await this.prisma.bookingJob.updateMany({
      where: {
        bookingRequestId: id,
        status: { in: [BookingStatus.QUEUED, BookingStatus.WORKER_ASSIGNED, BookingStatus.CHECKING_AVAILABILITY, BookingStatus.WATCHING] },
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
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (dto.action === 'SUCCESS_CONFIRMED') {
      if (!dto.officialReference) {
        throw new BadRequestException('Official reference is required when manually confirming');
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

      const updated = await this.prisma.bookingRequest.update({
        where: { id },
        data: {
          status: BookingStatus.SUCCESS,
          officialReference: dto.officialReference,
          requiresHumanNote: dto.notes ? `Manually confirmed: ${dto.notes}` : 'Manually confirmed by operator',
        },
      });

      return { message: 'Booking manually confirmed and funds captured', booking: updated };
    } else if (dto.action === 'RETRY_QUEUE') {
      const updated = await this.prisma.bookingRequest.update({
        where: { id },
        data: {
          status: BookingStatus.QUEUED,
          assignedMachineId: null,
          requiresHumanNote: null,
        },
      });

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
