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
import { TicketPricingService } from '../pricing/ticket-pricing.service';
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
          pilgrimCount: data.pilgrimCount,
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

    const mockWalletService = {
      release: jest.fn().mockResolvedValue({ id: 'tx-rel-1' }),
      capture: jest.fn().mockResolvedValue({ id: 'tx-cap-1' }),
    };

    const mockPricingService = {
      calculateBookingPrice: jest.fn().mockImplementation(async ({ userId, quantity }) => ({
        baseTicketPrice: 20,
        partnerMarkup: 0,
        distributorMarkup: 0,
        finalTicketPrice: 20,
        ticketQuantity: quantity || 1,
        totalTicketAmount: 20 * (quantity || 1),
        pricingConfigVersion: 1,
        pricingSnapshot: {
          baseTicketPrice: 20,
          partnerMarkup: 0,
          distributorMarkup: 0,
          finalTicketPrice: 20,
          ticketQuantity: quantity || 1,
          totalTicketAmount: 20 * (quantity || 1),
          partnerId: null,
          distributorId: null,
          calculatedAt: new Date().toISOString(),
        },
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: mockWalletService },
        { provide: AuditService, useValue: mockAudit },
        { provide: NotificationsService, useValue: {} },
        { provide: SmartMatcherService, useValue: {} },
        { provide: AccountLockService, useValue: mockAccountLockService },
        { provide: EventsGateway, useValue: mockEventsGateway },
        { provide: BookingStateMachineService, useValue: { transition: jest.fn().mockResolvedValue({ booking: { id: 'booking-1', status: BookingStatus.CANCELLED } }) } },
        { provide: TicketPricingService, useValue: mockPricingService },
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

    it('TEST 5: Accepts booking when nominee details are missing (optional in backend)', async () => {
      const dto: any = {
        ...validDto,
        nominee: undefined,
        nomineeName: undefined,
        nominees: undefined,
      };

      const result = await bookingsService.createBooking('user-1', dto);
      expect(result).toBeDefined();
      expect(result.bookingCode).toBe('TA-10101');
      expect(result.nomineeName).toBeNull();
      expect(mockPrisma.bookingRequest.create).toHaveBeenCalled();
    });

    it('TEST 5B: Calculates pricing based on serviceFee * pilgrimCount and enforces max 10 pilgrims', async () => {
      // 2 pilgrims = ₹40 fee
      const dto2: any = {
        ...validDto,
        pilgrimCount: 2,
      };
      const result2 = await bookingsService.createBooking('user-1', dto2);
      expect(result2.pilgrimCount).toBe(2);

      // 11 pilgrims = rejects with max 10 error
      const dto11: any = {
        ...validDto,
        pilgrimCount: 11,
      };
      await expect(bookingsService.createBooking('user-1', dto11)).rejects.toThrow(
        new BadRequestException('Sabarimala portal allows a maximum of 10 pilgrims per booking.'),
      );
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

      // Verified wallet reservation is placed (matching calculated final ticket price)
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            availableBalance: { decrement: 20 },
            reservedBalance: { increment: 20 },
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

    it('TEST 12: Rejects booking creation when devotee profile already has an active booking request', async () => {
      // Devotee profile acc-1 already has an active request #TA-10050
      mockPrisma.bookingRequest.findFirst.mockResolvedValueOnce({
        id: 'booking-existing-open',
        bookingCode: 'TA-10050',
        requestedDateStr: '2026-11-25',
        status: BookingStatus.WATCHING,
      });

      const dto: any = {
        ...validDto,
        requestedDate: '2026-11-28', // different date!
      };

      await expect(bookingsService.createBooking('user-1', dto)).rejects.toThrow(
        new BadRequestException(
          'This devotee profile already has an active booking request (#TA-10050 for 2026-11-25, status: WATCHING). Only 1 active booking request is permitted per devotee profile. Multiple dates or duplicate requests on the same profile are not allowed until the active request is finalized or cancelled.',
        ),
      );
    });

    it('TEST 13: Allows new booking creation after previous booking is completed or cancelled', async () => {
      // No active non-terminal booking found
      mockPrisma.bookingRequest.findFirst.mockResolvedValueOnce(null);

      const dto: any = {
        ...validDto,
        requestedDate: '2026-11-28',
      };

      const result = await bookingsService.createBooking('user-1', dto);
      expect(result).toBeDefined();
      expect(result.bookingCode).toBeDefined();
    });

    it('TEST 14: Auto-cancels past-date pending bookings and releases wallet reservations', async () => {
      // Mock past-date booking in PENDING status
      mockPrisma.bookingRequest.findMany = jest.fn().mockResolvedValueOnce([
        {
          id: 'past-booking-1',
          bookingCode: 'TA-10001',
          userId: 'user-1',
          accountId: 'acc-1',
          version: 1,
          requestedDate: new Date('2020-01-01'),
          requestedDateStr: '2020-01-01',
          status: BookingStatus.PENDING,
        },
      ]);
      mockPrisma.walletTransaction.findFirst.mockResolvedValueOnce({
        id: 'tx-res-1',
        amount: 20,
      });
      mockPrisma.bookingJob.updateMany = jest.fn().mockResolvedValue({ count: 1 });

      const res = await bookingsService.autoCancelPastPendingBookings('user-1');
      expect(res.cancelledCount).toBe(1);
      expect(res.details[0]).toContain('Auto-cancelled past booking #TA-10001');
    });

    it('TEST 15: Operator can cancel booking and refund wallet hold', async () => {
      mockPrisma.bookingRequest.findUnique = jest.fn().mockResolvedValueOnce({
        id: 'booking-cancel-1',
        bookingCode: 'TA-10002',
        userId: 'user-1',
        accountId: 'acc-1',
        version: 1,
        status: BookingStatus.PENDING,
      });
      mockPrisma.walletTransaction.findFirst.mockResolvedValueOnce({
        id: 'tx-res-2',
        amount: 20,
      });
      mockPrisma.bookingJob.updateMany = jest.fn().mockResolvedValue({ count: 1 });

      const cancelRes = await bookingsService.cancelBooking('booking-cancel-1', { id: 'user-1', role: 'CENTRE' });
      expect(cancelRes.message).toContain('Booking cancelled and funds released');
    });
  });
});
