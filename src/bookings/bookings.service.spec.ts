import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { AccountLockService } from '../availability/account-lock.service';
import { EventsGateway } from '../events/events.gateway';
import { BookingStateMachineService } from './booking-state-machine.service';
import { SmartAllocatorService } from '../workers/smart-allocator.service';
import { BookingStatus, JobType, AccountStatus } from '@prisma/client';

describe('BookingsService - Booking Readiness & Queue Protection', () => {
  let bookingsService: BookingsService;
  let mockPrisma: any;
  let mockAudit: any;
  let mockAccountLockService: any;

  const validDto = {
    requestedDate: '2026-11-20',
    route: 'Pamba (Regular Footpath Route)',
    termsAccepted: true,
    accountId: 'acc-1',
    nominee: {
      nomineeName: 'Swami Nominee',
      nomineeAge: 35,
      nomineeRelationship: 'BROTHER',
      nomineePhone: '9876543210',
    },
  };

  beforeEach(async () => {
    mockPrisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-1', role: 'CENTRE' }),
      },
      bookingAccount: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'acc-1',
          userId: 'user-1',
          status: AccountStatus.VERIFIED,
          username: 'portal_user',
          encryptedPassword: 'enc',
          iv: 'iv',
        }),
        create: jest.fn().mockResolvedValue({
          id: 'acc-new-1',
          userId: 'user-1',
          status: AccountStatus.UNVERIFIED,
          username: 'new_user',
        }),
      },
      bookingRequest: {
        count: jest.fn().mockResolvedValue(100),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => ({
          id: 'booking-uuid-1',
          bookingCode: data.bookingCode,
          status: data.status,
          preferences: data.preferences,
          requestedDate: data.requestedDate,
          route: data.route,
          accountId: data.accountId,
          nomineeName: data.nomineeName,
          nomineeAge: data.nomineeAge,
          nomineeRelationship: data.nomineeRelationship,
        })),
      },
      bookingPilgrim: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      availabilityOpportunity: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
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
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'tx-1' }),
      },
      $transaction: jest.fn().mockImplementation(async (callback) => {
        return callback(mockPrisma);
      }),
    };

    mockAudit = {
      log: jest.fn().mockResolvedValue({ id: 'audit-log-1' }),
    };

    mockAccountLockService = {
      isLocked: jest.fn().mockResolvedValue(false),
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
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
        { provide: AccountLockService, useValue: mockAccountLockService },
        { provide: EventsGateway, useValue: mockEventsGateway },
        { provide: BookingStateMachineService, useValue: { transition: jest.fn().mockResolvedValue({}) } },
        { provide: SmartAllocatorService, useValue: { runAllocationSweep: jest.fn().mockResolvedValue({}) } },
      ],
    }).compile();

    bookingsService = module.get<BookingsService>(BookingsService);
  });

  describe('Terms Acceptance Enforcement', () => {
    it('TEST 1: Rejects booking request when termsAccepted is false', async () => {
      const dto: any = {
        ...validDto,
        termsAccepted: false,
      };

      await expect(bookingsService.createBooking('user-1', dto)).rejects.toThrow(
        new BadRequestException(
          'Please accept the Terms & Conditions and Refund Policy before continuing.',
        ),
      );

      expect(mockPrisma.bookingRequest.create).not.toHaveBeenCalled();
      expect(mockPrisma.bookingJob.create).not.toHaveBeenCalled();
      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
      expect(mockPrisma.walletTransaction.create).not.toHaveBeenCalled();
      expect(mockAudit.log).not.toHaveBeenCalled();
    });

    it('TEST 2: Rejects booking request when termsAccepted is omitted/undefined', async () => {
      const dto: any = {
        ...validDto,
        termsAccepted: undefined,
      };

      await expect(bookingsService.createBooking('user-1', dto)).rejects.toThrow(
        new BadRequestException(
          'Please accept the Terms & Conditions and Refund Policy before continuing.',
        ),
      );

      expect(mockPrisma.bookingRequest.create).not.toHaveBeenCalled();
      expect(mockPrisma.bookingJob.create).not.toHaveBeenCalled();
    });
  });

  describe('Pilgrim and Nominee Validation Gate', () => {
    it('TEST 3: Successfully accepts booking with only nominee (devotees selected from official account profile)', async () => {
      const dto: any = {
        ...validDto,
      };

      const result = await bookingsService.createBooking('user-1', dto);
      expect(result).toBeDefined();
      expect(result.status).toBe(BookingStatus.PENDING);
      expect(mockPrisma.bookingRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            nomineeName: 'Swami Nominee',
            pilgrimCount: 1,
          }),
        }),
      );
    });

    it('TEST 4: Rejects booking when pilgrim has invalid age or missing id', async () => {
      const dto: any = {
        ...validDto,
        pilgrims: [{ fullName: 'Test Devotee', age: 0, gender: 'MALE', idType: 'AADHAAR' }],
      };

      await expect(bookingsService.createBooking('user-1', dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.bookingRequest.create).not.toHaveBeenCalled();
    });

    it('TEST 5: Rejects booking when nominee details are missing', async () => {
      const dto: any = {
        ...validDto,
        nominee: undefined,
        nomineeName: undefined,
      };

      await expect(bookingsService.createBooking('user-1', dto)).rejects.toThrow(
        new BadRequestException('Nominee name is required for pilgrim insurance.'),
      );
      expect(mockPrisma.bookingRequest.create).not.toHaveBeenCalled();
    });

    it('TEST 6: Rejects booking when nominee is underage (< 18)', async () => {
      const dto: any = {
        ...validDto,
        nominee: {
          nomineeName: 'Minor Nominee',
          nomineeAge: 16,
          nomineeRelationship: 'SON',
          nomineePhone: '9876543210',
        },
      };

      await expect(bookingsService.createBooking('user-1', dto)).rejects.toThrow(
        new BadRequestException('Nominee must be an adult with a valid age (minimum 18 years).'),
      );
      expect(mockPrisma.bookingRequest.create).not.toHaveBeenCalled();
    });

    it('TEST 6b: Successfully accepts booking with multiple nominees in nominees array', async () => {
      const dto: any = {
        ...validDto,
        nominees: [
          {
            nomineeName: 'Primary Nominee',
            nomineeAge: 30,
            nomineeRelationship: 'SPOUSE',
            nomineePhone: '9876543210',
          },
          {
            nomineeName: 'Secondary Nominee',
            nomineeAge: 55,
            nomineeRelationship: 'FATHER',
            nomineePhone: '9876543211',
          },
        ],
      };

      const result = await bookingsService.createBooking('user-1', dto);
      expect(result).toBeDefined();
      expect(mockPrisma.bookingRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            nomineeName: 'Primary Nominee',
            nomineeAge: 30,
            nomineeRelationship: 'SPOUSE',
          }),
        }),
      );
    });
  });

  describe('Official Portal Account Ownership & Verification Gate', () => {
    it('TEST 7: Rejects booking if account is not owned by the authenticated user', async () => {
      mockPrisma.bookingAccount.findUnique.mockResolvedValueOnce({
        id: 'acc-other',
        userId: 'different-user-999',
        status: AccountStatus.VERIFIED,
      });

      const dto: any = {
        ...validDto,
        accountId: 'acc-other',
      };

      await expect(bookingsService.createBooking('user-1', dto)).rejects.toThrow(
        new ForbiddenException('You do not have permission to use this devotee account.'),
      );
      expect(mockPrisma.bookingRequest.create).not.toHaveBeenCalled();
    });

    it('TEST 8: Rejects booking execution if selected account is UNVERIFIED', async () => {
      mockPrisma.bookingAccount.findUnique.mockResolvedValueOnce({
        id: 'acc-1',
        userId: 'user-1',
        status: AccountStatus.UNVERIFIED,
      });

      await expect(bookingsService.createBooking('user-1', validDto)).rejects.toThrow(
        new BadRequestException(
          'Devotee account credentials must be verified before booking can proceed. Current status: UNVERIFIED',
        ),
      );
      expect(mockPrisma.bookingRequest.create).not.toHaveBeenCalled();
    });
  });

  describe('Queue Admission & Premature Job Elimination', () => {
    it('TEST 9: When slot is NOT available immediately, persists booking as PENDING and DOES NOT create execution job', async () => {
      mockPrisma.availabilityOpportunity.findFirst.mockResolvedValueOnce(null);

      const result = await bookingsService.createBooking('user-1', validDto);

      expect(result).toBeDefined();
      expect(result.status).toBe(BookingStatus.PENDING);

      // Verified booking created in PENDING state
      expect(mockPrisma.bookingRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: BookingStatus.PENDING,
            nomineeName: 'Swami Nominee',
          }),
        }),
      );

      // Verified NO premature BookingJob was created
      expect(mockPrisma.bookingJob.create).not.toHaveBeenCalled();

      // Verified wallet reservation is placed
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            availableBalance: { decrement: 150 },
            reservedBalance: { increment: 150 },
          },
        }),
      );

      // Verified audit log for terms
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'TERMS_ACCEPTED',
        }),
      );
    });

    it('TEST 10: When slot IS available immediately, transitions to EXECUTION_QUEUED and creates BOOKING_EXECUTION job', async () => {
      mockPrisma.availabilityOpportunity.findFirst.mockResolvedValueOnce({
        id: 'opp-available-1',
        date: '2026-11-20',
        route: 'Pamba',
        timeSlot: '08:00-09:00',
        status: 'AVAILABLE',
      });

      const result = await bookingsService.createBooking('user-1', validDto);

      expect(result).toBeDefined();
      expect(result.status).toBe(BookingStatus.EXECUTION_QUEUED);

      // Account lock acquired
      expect(mockAccountLockService.acquireLock).toHaveBeenCalledWith('acc-1', expect.any(String));

      // Availability opportunity marked MATCHED
      expect(mockPrisma.availabilityOpportunity.update).toHaveBeenCalledWith({
        where: { id: 'opp-available-1' },
        data: { status: 'MATCHED' },
      });

      // Executable job created transactionally
      expect(mockPrisma.bookingJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            jobType: JobType.BOOKING_EXECUTION,
            status: BookingStatus.QUEUED,
          }),
        }),
      );
    });

    it('TEST 11: Idempotency check returns existing booking and prevents duplicate creation or duplicate wallet holds', async () => {
      mockPrisma.walletTransaction.findUnique.mockResolvedValueOnce({
        id: 'existing-tx-id',
        booking: { id: 'booking-1', bookingCode: 'TA-1000' },
      });

      const dto: any = {
        ...validDto,
        idempotencyKey: 'duplicate-key-123',
      };

      const result = await bookingsService.createBooking('user-1', dto);
      expect(result).toBeDefined();
      expect(result.id).toBe('booking-1');
      expect(mockPrisma.bookingRequest.create).not.toHaveBeenCalled();
      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    });
  });
});
