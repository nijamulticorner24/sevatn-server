import { Test, TestingModule } from '@nestjs/testing';
import { BookingStateMachineService } from './booking-state-machine.service';
import { PrismaService } from '../prisma/prisma.service';
import { BookingStatus, ExecutionStatus, FinancialStatus } from '@prisma/client';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { validateNominee } from '../common/nominee-validator';

describe('SEVATN Phase 4 Autonomous State Machine & Nominee Verification Suite', () => {
  let stateMachine: BookingStateMachineService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      bookingRequest: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      bookingMilestone: {
        create: jest.fn(),
      },
      $transaction: jest.fn((callback) => callback(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingStateMachineService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    stateMachine = module.get<BookingStateMachineService>(BookingStateMachineService);
  });

  describe('1. Phase 4 Linear Autonomous Progression Graph', () => {
    it('permits the complete 19-step autonomous lifecycle from QUEUED to BOOKING_CONFIRMED', () => {
      // 1. Queue to Discovering
      expect(stateMachine.canTransition(BookingStatus.QUEUED, BookingStatus.DISCOVERING)).toBe(true);

      // 2. Discovering to Claimed
      expect(stateMachine.canTransition(BookingStatus.DISCOVERING, BookingStatus.CLAIMED)).toBe(true);

      // 3. Claimed to Login Success
      expect(stateMachine.canTransition(BookingStatus.CLAIMED, BookingStatus.LOGIN_SUCCESS)).toBe(true);

      // 4. Login Success to Date Verified
      expect(stateMachine.canTransition(BookingStatus.LOGIN_SUCCESS, BookingStatus.DATE_VERIFIED)).toBe(true);

      // 5. Date Verified to Route Verified
      expect(stateMachine.canTransition(BookingStatus.DATE_VERIFIED, BookingStatus.ROUTE_VERIFIED)).toBe(true);

      // 6. Route Verified to Slot Verified
      expect(stateMachine.canTransition(BookingStatus.ROUTE_VERIFIED, BookingStatus.SLOT_VERIFIED)).toBe(true);

      // 7. Slot Verified to Pilgrims Verified
      expect(stateMachine.canTransition(BookingStatus.SLOT_VERIFIED, BookingStatus.PILGRIMS_VERIFIED)).toBe(true);

      // 8. Pilgrims Verified to Nominee Verified
      expect(stateMachine.canTransition(BookingStatus.PILGRIMS_VERIFIED, BookingStatus.NOMINEE_VERIFIED)).toBe(true);

      // 9. Nominee Verified to Relief Verified
      expect(stateMachine.canTransition(BookingStatus.NOMINEE_VERIFIED, BookingStatus.RELIEF_VERIFIED)).toBe(true);

      // 10. Relief Verified to Wishlist Verified
      expect(stateMachine.canTransition(BookingStatus.RELIEF_VERIFIED, BookingStatus.WISHLIST_VERIFIED)).toBe(true);

      // 11. Wishlist Verified to Payment Initialized
      expect(stateMachine.canTransition(BookingStatus.WISHLIST_VERIFIED, BookingStatus.PAYMENT_INITIALIZED)).toBe(true);

      // 12. Payment Initialized to Zero-Cost Confirmation Pending
      expect(stateMachine.canTransition(BookingStatus.PAYMENT_INITIALIZED, BookingStatus.ZERO_COST_CONFIRMATION_PENDING)).toBe(true);

      // 13. Payment Initialized to Payment Pending (Paid Flow)
      expect(stateMachine.canTransition(BookingStatus.PAYMENT_INITIALIZED, BookingStatus.PAYMENT_PENDING)).toBe(true);

      // 14. Zero Cost to Confirmation Pending
      expect(stateMachine.canTransition(BookingStatus.ZERO_COST_CONFIRMATION_PENDING, BookingStatus.CONFIRMATION_PENDING)).toBe(true);

      // 15. Confirmation Pending to Booking Confirmed
      expect(stateMachine.canTransition(BookingStatus.CONFIRMATION_PENDING, BookingStatus.BOOKING_CONFIRMED)).toBe(true);

      // 16. Confirmed to Terminal Completed
      expect(stateMachine.canTransition(BookingStatus.BOOKING_CONFIRMED, BookingStatus.COMPLETED)).toBe(true);
    });

    it('strictly forbids invalid forward and backward jumps', () => {
      // Cannot skip directly from QUEUED to BOOKING_CONFIRMED
      expect(stateMachine.canTransition(BookingStatus.QUEUED, BookingStatus.BOOKING_CONFIRMED)).toBe(false);

      // Cannot jump from CLAIMED to BOOKING_CONFIRMED
      expect(stateMachine.canTransition(BookingStatus.CLAIMED, BookingStatus.BOOKING_CONFIRMED)).toBe(false);

      // Terminal COMPLETED cannot transition to QUEUED or CLAIMED
      expect(stateMachine.canTransition(BookingStatus.COMPLETED, BookingStatus.QUEUED)).toBe(false);

      // CANCELLED cannot transition to EXECUTING
      expect(stateMachine.canTransition(BookingStatus.CANCELLED, BookingStatus.CLAIMED)).toBe(false);
    });
  });

  describe('2. Atomic CAS and Version Concurrency Protection', () => {
    it('executes atomic compare-and-swap and records milestone within transaction', async () => {
      prisma.bookingRequest.findUnique.mockResolvedValue({
        id: 'book-phase4-001',
        bookingCode: 'TA-10045',
        status: BookingStatus.CONFIRMATION_PENDING,
        version: 5,
      });

      const result = await stateMachine.transition({
        bookingId: 'book-phase4-001',
        targetStatus: BookingStatus.BOOKING_CONFIRMED,
        targetExecutionStatus: ExecutionStatus.COMPLETED,
        targetFinancialStatus: FinancialStatus.CAPTURED,
        expectedVersion: 5,
        milestone: 'CONFIRMED',
        officialReference: 'IVQ26103016320889516047',
      });

      expect(result.success).toBe(true);
      expect(result.newStatus).toBe(BookingStatus.BOOKING_CONFIRMED);
      expect(result.version).toBe(6);

      // Verify CAS query was executed with exact expected version
      expect(prisma.bookingRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'book-phase4-001', version: 5 },
        data: expect.objectContaining({
          status: BookingStatus.BOOKING_CONFIRMED,
          officialReference: 'IVQ26103016320889516047',
          lastMilestone: 'CONFIRMED',
        }),
      });

      // Verify milestone record created
      expect(prisma.bookingMilestone.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bookingRequestId: 'book-phase4-001',
          milestone: 'CONFIRMED',
        }),
      });
    });

    it('rejects concurrent modification when version has changed (Optimistic Lock Failure)', async () => {
      prisma.bookingRequest.findUnique.mockResolvedValue({
        id: 'book-phase4-002',
        bookingCode: 'TA-10046',
        status: BookingStatus.CLAIMED,
        version: 3, // Record in DB is at version 3
      });

      await expect(
        stateMachine.transition({
          bookingId: 'book-phase4-002',
          targetStatus: BookingStatus.LOGIN_SUCCESS,
          expectedVersion: 2, // Caller expects version 2 (stale read)
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('3. Reusable Nominee Validation Logic', () => {
    it('accepts completely valid adult nominee details', () => {
      const res = validateNominee({
        nomineeName: 'Nija Kumar',
        nomineeAge: 23,
        nomineeRelationship: 'Brother',
      });

      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
      expect(res.resolvedNominee?.nomineeName).toBe('Nija Kumar');
      expect(res.resolvedNominee?.nomineeAge).toBe(23);
    });

    it('rejects missing or whitespace nominee name', () => {
      const res = validateNominee({
        nomineeName: '   ',
        nomineeAge: 25,
        nomineeRelationship: 'Spouse',
      });

      expect(res.valid).toBe(false);
      expect(res.errors[0]).toMatch(/Nominee name must be at least 2 characters/i);
    });

    it('rejects underage nominee (<18 years)', () => {
      const res = validateNominee({
        nomineeName: 'Child Nominee',
        nomineeAge: 17,
        nomineeRelationship: 'Son',
      });

      expect(res.valid).toBe(false);
      expect(res.errors[0]).toMatch(/adult with a valid age between 18 and 120/i);
    });

    it('rejects missing nominee relationship', () => {
      const res = validateNominee({
        nomineeName: 'Valid Name',
        nomineeAge: 35,
        nomineeRelationship: '',
      });

      expect(res.valid).toBe(false);
      expect(res.errors[0]).toMatch(/relationship is required/i);
    });

    it('validates per-pilgrim nominee association when explicitly provided', () => {
      const res = validateNominee({
        nomineeName: 'Primary Nominee',
        nomineeAge: 40,
        nomineeRelationship: 'Father',
        pilgrims: [
          {
            fullName: 'Pilgrim One',
            age: 20,
            nominee: {
              nomineeName: 'Invalid Child Nominee',
              nomineeAge: 15, // Underage
              nomineeRelationship: 'Sister',
            },
          },
        ],
      });

      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('Pilgrim #1'))).toBe(true);
    });
  });

  describe('4. Ambiguous Payment Outcome & Reconciliation Transitions', () => {
    it('allows transition from PAYMENT_INITIALIZED to PAYMENT_UNKNOWN and then RECONCILIATION_REQUIRED', () => {
      expect(stateMachine.canTransition(BookingStatus.PAYMENT_INITIALIZED, BookingStatus.PAYMENT_UNKNOWN)).toBe(true);
      expect(stateMachine.canTransition(BookingStatus.PAYMENT_UNKNOWN, BookingStatus.RECONCILIATION_REQUIRED)).toBe(true);
      expect(stateMachine.canTransition(BookingStatus.RECONCILIATION_REQUIRED, BookingStatus.BOOKING_CONFIRMED)).toBe(true);
      expect(stateMachine.canTransition(BookingStatus.RECONCILIATION_REQUIRED, BookingStatus.BOOKING_FAILED)).toBe(true);
    });

    it('permits retryable failures to re-queue cleanly', () => {
      expect(stateMachine.canTransition(BookingStatus.RETRYABLE_FAILURE, BookingStatus.QUEUED)).toBe(true);
      expect(stateMachine.canTransition(BookingStatus.HOLD_INVALID_NOMINEE, BookingStatus.QUEUED)).toBe(true);
    });
  });
});

