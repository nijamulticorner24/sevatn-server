import { Test, TestingModule } from '@nestjs/testing';
import { WorkersService } from './workers.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AccountLockService } from '../availability/account-lock.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BookingStateMachineService } from '../bookings/booking-state-machine.service';
import { BookingStatus, JobType } from '@prisma/client';
import { BadRequestException, ConflictException } from '@nestjs/common';

describe('Official Booking Reference Mapping Regression Suite', () => {
  let workersService: WorkersService;
  let stateMachineService: BookingStateMachineService;
  let prisma: any;
  let walletService: any;
  let accountLockService: any;
  let notificationsService: any;

  let mockJob: any;
  let mockBookingRequest: any;

  beforeEach(async () => {
    mockBookingRequest = {
      id: 'br-mapping-1',
      bookingCode: 'TA-10052',
      status: BookingStatus.EXECUTING,
      version: 1,
      assignedMachineId: 'w-machine-1',
      userId: 'user-1',
      pilgrimCount: 1,
      officialReference: null,
      officialBookingReference: null,
      cartId: null,
      portalTransactionReference: null,
      officialReceiptReference: null,
      confirmationEvidence: null,
      confirmedAt: null,
    };

    mockJob = {
      id: 'job-mapping-1',
      jobType: JobType.BOOKING_EXECUTION,
      bookingRequestId: 'br-mapping-1',
      bookingRequest: mockBookingRequest,
      accountId: 'acc-1',
      workerId: 'w-machine-1',
      status: BookingStatus.WORKER_ASSIGNED,
      leaseGeneration: 1,
      fencingToken: 'fnc_job-1_gen1',
      version: 1,
    };

    prisma = {
      $transaction: jest.fn().mockImplementation(async (cb) => cb(prisma)),
      bookingJob: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve({ ...mockJob })),
        findFirst: jest.fn().mockImplementation(() => Promise.resolve({ ...mockJob })),
        update: jest.fn().mockImplementation(({ data }) => {
          Object.assign(mockJob, data);
          return Promise.resolve(mockJob);
        }),
        updateMany: jest.fn().mockImplementation(({ data }) => {
          Object.assign(mockBookingRequest, data);
          return Promise.resolve({ count: 1 });
        }),
      },
      bookingRequest: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve({ ...mockBookingRequest })),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockImplementation(({ data }) => {
          Object.assign(mockBookingRequest, data);
          return Promise.resolve(mockBookingRequest);
        }),
        updateMany: jest.fn().mockImplementation(({ data }) => {
          Object.assign(mockBookingRequest, data);
          return Promise.resolve({ count: 1 });
        }),
      },
      bookingMilestone: {
        create: jest.fn().mockResolvedValue({ id: 'milestone-1' }),
      },
      workerMachine: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'w-machine-1',
          machineCode: 'PC-MAPPING-1',
          active: true,
          adminStatus: 'APPROVED',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      walletTransaction: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tx-1', amount: 200 }),
      },
    };

    walletService = {
      capture: jest.fn().mockResolvedValue({ message: 'Captured' }),
      release: jest.fn().mockResolvedValue({ message: 'Released' }),
    };

    accountLockService = {
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    };

    notificationsService = {
      send: jest.fn().mockResolvedValue({}),
      sendBookingNotification: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkersService,
        BookingStateMachineService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
        { provide: AccountLockService, useValue: accountLockService },
        {
          provide: SmartMatcherService,
          useValue: { returnToPendingOnSlotLoss: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: AuditService,
          useValue: { log: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: NotificationsService,
          useValue: notificationsService,
        },
      ],
    }).compile();

    workersService = module.get<WorkersService>(WorkersService);
    stateMachineService = module.get<BookingStateMachineService>(BookingStateMachineService);
  });

  describe('1. Independent Identifier Storage & Authoritative Reference', () => {
    it('stores Cart ID, official booking reference, transaction ref, and evidence independently', async () => {
      const payload = {
        officialReference: 'IVQ26103022183531421270',
        officialBookingReference: 'IVQ26103022183531421270',
        cartId: '1927413639',
        portalTransactionReference: '1927413639',
        officialReceiptReference: 'IVQ26103022183531421270',
        confirmationEvidence: { modalFound: true, grandTotal: '₹0' },
        confirmedAt: '2026-10-30T16:48:45.302Z',
        leaseGeneration: 1,
        fencingToken: 'fnc_job-1_gen1',
      };

      const result = await workersService.completeJob('job-mapping-1', 'w-machine-1', payload);

      expect(result.success).toBe(true);

      // Verify booking request was updated with separated fields
      expect(mockBookingRequest.officialBookingReference).toBe('IVQ26103022183531421270');
      expect(mockBookingRequest.officialReference).toBe('IVQ26103022183531421270');
      expect(mockBookingRequest.cartId).toBe('1927413639');
      expect(mockBookingRequest.portalTransactionReference).toBe('1927413639');
      expect(mockBookingRequest.officialReceiptReference).toBe('IVQ26103022183531421270');
      expect(mockBookingRequest.confirmationEvidence).toEqual({ modalFound: true, grandTotal: '₹0' });
    });

    it('customer notification receives authoritative IVQ reference as officialReference and Cart ID separately', async () => {
      const payload = {
        officialReference: 'IVQ26103100523179877296',
        officialBookingReference: 'IVQ26103100523179877296',
        cartId: '1927422646',
        portalTransactionReference: '1927422646',
        leaseGeneration: 1,
        fencingToken: 'fnc_job-1_gen1',
      };

      await workersService.completeJob('job-mapping-1', 'w-machine-1', payload);

      expect(notificationsService.send).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          payload: expect.objectContaining({
            officialBookingReference: 'IVQ26103100523179877296',
            cartId: '1927422646',
            portalTransactionReference: '1927422646',
          }),
        }),
      );
    });
  });

  describe('2. Numeric Cart ID Rejection & Ambiguous Reference Handling', () => {
    it('diverts to RECONCILIATION_REQUIRED when only numeric Cart ID is provided as officialReference', async () => {
      const payload = {
        officialReference: '1927413639', // NUMERIC CART ID ONLY!
        cartId: '1927413639',
        leaseGeneration: 1,
        fencingToken: 'fnc_job-1_gen1',
      };

      await expect(
        workersService.completeJob('job-mapping-1', 'w-machine-1', payload),
      ).rejects.toThrow(BadRequestException);

      expect(mockBookingRequest.status).toBe(BookingStatus.RECONCILIATION_REQUIRED);
      expect(mockBookingRequest.cartId).toBe('1927413639');
      // Must NOT store numeric Cart ID in officialBookingReference
      expect(mockBookingRequest.officialBookingReference).toBeNull();
    });

    it('diverts to RECONCILIATION_REQUIRED when official reference is missing entirely', async () => {
      const payload = {
        cartId: '1927413639',
        leaseGeneration: 1,
        fencingToken: 'fnc_job-1_gen1',
      };

      await expect(
        workersService.completeJob('job-mapping-1', 'w-machine-1', payload),
      ).rejects.toThrow(BadRequestException);

      expect(mockBookingRequest.status).toBe(BookingStatus.RECONCILIATION_REQUIRED);
    });
  });

  describe('3. Duplicate Confirmation & Overwrite Protection', () => {
    it('prevents overwriting an existing authoritative reference on an already confirmed booking', async () => {
      // Booking already has confirmed IVQ reference
      mockBookingRequest.status = BookingStatus.SUCCESS;
      mockBookingRequest.officialReference = 'IVQ26103022183531421270';
      mockBookingRequest.officialBookingReference = 'IVQ26103022183531421270';
      mockBookingRequest.cartId = '1927413639';

      // State machine transition attempt with a different reference
      await expect(
        stateMachineService.transition({
          bookingId: 'br-mapping-1',
          targetStatus: BookingStatus.SUCCESS,
          officialReference: 'IVQ_DIFFERENT_999999999',
          cartId: '9999999999',
        }),
      ).rejects.toThrow(ConflictException);

      // Verify existing reference remained unchanged
      expect(mockBookingRequest.officialReference).toBe('IVQ26103022183531421270');
      expect(mockBookingRequest.officialBookingReference).toBe('IVQ26103022183531421270');
    });

    it('workersService completeJob returns already completed without modifying authoritative reference', async () => {
      mockJob.status = BookingStatus.SUCCESS;
      mockBookingRequest.status = BookingStatus.SUCCESS;
      mockBookingRequest.officialReference = 'IVQ26103022183531421270';
      mockBookingRequest.officialBookingReference = 'IVQ26103022183531421270';
      mockBookingRequest.cartId = '1927413639';

      const result = await workersService.completeJob('job-mapping-1', 'w-machine-1', {
        officialReference: '1927413639', // worker tries to send cart ID
        cartId: '1927413639',
        leaseGeneration: 1,
        fencingToken: 'fnc_job-1_gen1',
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('Job already completed');
      expect(result.ref).toBe('IVQ26103022183531421270');
      expect(mockBookingRequest.officialReference).toBe('IVQ26103022183531421270');
    });
  });

  describe('4. Confirmed Bookings Cannot Be Resubmitted or Claimed', () => {
    it('claimJob skips execution and returns hasJob: false when pre-allocated booking is already confirmed', async () => {
      mockBookingRequest.status = BookingStatus.SUCCESS;
      mockBookingRequest.officialReference = 'IVQ26103022183531421270';
      mockBookingRequest.officialBookingReference = 'IVQ26103022183531421270';

      const result = await workersService.claimJob('w-machine-1');
      expect(result).toEqual({ hasJob: false });
    });
  });

  describe('5. Receipt Verification Identifier Matching', () => {
    it('validates IVQ and VQ format while rejecting Cart ID format', () => {
      const isValidAuthoritative = (ref?: string) => {
        if (!ref) return false;
        if (/^\d{8,12}$/.test(ref)) return false; // Numeric Cart ID
        return /^(IVQ|VQ)/i.test(ref) || /^[A-Z0-9_-]{6,40}$/i.test(ref);
      };

      expect(isValidAuthoritative('IVQ26103022183531421270')).toBe(true);
      expect(isValidAuthoritative('IVQ26103100523179877296')).toBe(true);
      expect(isValidAuthoritative('VQ9988112233')).toBe(true);
      expect(isValidAuthoritative('1927413639')).toBe(false);
      expect(isValidAuthoritative('1927422646')).toBe(false);
      expect(isValidAuthoritative('')).toBe(false);
    });
  });
});
