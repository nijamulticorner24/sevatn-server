import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { AccountLockService } from '../availability/account-lock.service';
import { EventsGateway } from '../events/events.gateway';
import { BookingStatus, JobType } from '@prisma/client';

describe('BookingsService - Terms Acceptance Enforcement', () => {
  let bookingsService: BookingsService;
  let mockPrisma: any;
  let mockAudit: any;

  beforeEach(async () => {
    mockPrisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-1', role: 'CENTRE' }),
      },
      bookingRequest: {
        count: jest.fn().mockResolvedValue(100),
        create: jest.fn().mockImplementation(({ data }) => ({
          id: 'booking-uuid-1',
          bookingCode: data.bookingCode,
          status: data.status,
          preferences: data.preferences,
          requestedDate: data.requestedDate,
          route: data.route,
        })),
      },
      bookingJob: {
        create: jest.fn().mockResolvedValue({ id: 'job-uuid-1', status: BookingStatus.QUEUED }),
      },
      systemConfig: {
        findUnique: jest.fn().mockResolvedValue({ id: 'default', serviceFee: '150' }),
      },
      wallet: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'wallet-1',
          userId: 'user-1',
          availableBalance: '500.00',
          reservedBalance: '0.00',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      walletTransaction: {
        create: jest.fn().mockResolvedValue({ id: 'tx-1' }),
      },
      $transaction: jest.fn().mockImplementation(async (callback) => {
        return callback(mockPrisma);
      }),
    };

    mockAudit = {
      log: jest.fn().mockResolvedValue({ id: 'audit-log-1' }),
    };

    const mockEventsGateway = {
      notifyBookingUpdated: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: {} },
        { provide: AuditService, useValue: mockAudit },
        { provide: NotificationsService, useValue: {} },
        { provide: SmartMatcherService, useValue: {} },
        { provide: AccountLockService, useValue: {} },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    bookingsService = module.get<BookingsService>(BookingsService);
  });

  it('TEST 1: Rejects booking request when termsAccepted is false (Direct API or unchecked UI)', async () => {
    const dto: any = {
      requestedDate: '2026-11-20',
      route: 'Pamba (Regular Footpath Route)',
      termsAccepted: false,
    };

    await expect(bookingsService.createBooking('user-1', dto)).rejects.toThrow(
      new BadRequestException(
        'Please accept the Terms & Conditions and Refund Policy before continuing.',
      ),
    );

    // Verify no booking, no job, and no wallet transactions were executed
    expect(mockPrisma.bookingRequest.create).not.toHaveBeenCalled();
    expect(mockPrisma.bookingJob.create).not.toHaveBeenCalled();
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(mockAudit.log).not.toHaveBeenCalled();
  });

  it('TEST 2: Rejects booking request when termsAccepted is omitted/undefined', async () => {
    const dto: any = {
      requestedDate: '2026-11-20',
      route: 'Pamba (Regular Footpath Route)',
    };

    await expect(bookingsService.createBooking('user-1', dto)).rejects.toThrow(
      new BadRequestException(
        'Please accept the Terms & Conditions and Refund Policy before continuing.',
      ),
    );

    expect(mockPrisma.bookingRequest.create).not.toHaveBeenCalled();
    expect(mockPrisma.bookingJob.create).not.toHaveBeenCalled();
  });

  it('TEST 3: Successfully queues request and records consent in audit log when termsAccepted is true', async () => {
    const dto: any = {
      requestedDate: '2026-11-20',
      route: 'Pamba (Regular Footpath Route)',
      termsAccepted: true,
    };

    const result = await bookingsService.createBooking('user-1', dto);

    // Verified booking created
    expect(result).toBeDefined();
    expect(mockPrisma.bookingRequest.create).toHaveBeenCalled();
    expect(mockPrisma.bookingJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          jobType: JobType.BOOKING_EXECUTION,
          status: BookingStatus.QUEUED,
        }),
      }),
    );

    // Verified consent recorded in audit log
    expect(mockAudit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        actorType: 'USER',
        action: 'TERMS_ACCEPTED',
        entity: 'BookingRequest',
        entityId: 'booking-uuid-1',
        metadata: expect.objectContaining({
          termsAccepted: true,
          termsUrl: '/terms-and-conditions',
          refundPolicyUrl: '/refund-policy',
        }),
      }),
    );
  });

  it('TEST 4: Fee is only held in reservation and not debited/captured upon queuing', async () => {
    const dto: any = {
      requestedDate: '2026-11-20',
      route: 'Pamba (Regular Footpath Route)',
      termsAccepted: true,
    };

    await bookingsService.createBooking('user-1', dto);

    // Fee reserved (hold), NOT captured/debited
    expect(mockPrisma.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        data: {
          availableBalance: { decrement: 150 },
          reservedBalance: { increment: 150 },
        },
      }),
    );

    expect(mockPrisma.walletTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'RESERVE',
          amount: 150,
          status: 'COMPLETED',
        }),
      }),
    );
  });
});
