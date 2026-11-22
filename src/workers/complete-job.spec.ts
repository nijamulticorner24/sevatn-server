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

describe('completeJob Idempotency, Atomicity, and Pass Protection Suite', () => {
  let workersService: WorkersService;
  let prisma: any;
  let walletService: any;
  let accountLockService: any;
  let notificationsService: any;

  let mockJob: any;
  let mockBookingRequest: any;

  beforeEach(async () => {
    mockBookingRequest = {
      id: 'br-atomic-1',
      bookingCode: 'TA-10051',
      status: BookingStatus.EXECUTING,
      version: 1,
      assignedMachineId: 'w-machine-1',
      userId: 'user-1',
      pilgrimCount: 1,
      requestedDate: new Date('2026-11-21'),
      requestedDateStr: '2026-11-21',
      route: 'Pamba (Regular Footpath Route)',
      selectedTime: null,
      officialReference: null,
      officialBookingReference: null,
      cartId: null,
      portalTransactionReference: null,
      confirmationData: null,
      reconciliationStatus: null,
    };

    mockJob = {
      id: 'job-atomic-1',
      jobType: JobType.BOOKING_EXECUTION,
      bookingRequestId: 'br-atomic-1',
      bookingRequest: mockBookingRequest,
      accountId: 'acc-1',
      workerId: 'w-machine-1',
      status: BookingStatus.EXECUTING,
      leaseGeneration: 1,
      fencingToken: 'token-123',
    };

    prisma = {
      $transaction: jest.fn().mockImplementation(async (cb) => cb(prisma)),
      bookingJob: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve({ ...mockJob })),
        updateMany: jest.fn().mockImplementation(({ data }) => {
          Object.assign(mockJob, data);
          return Promise.resolve({ count: 1 });
        }),
        update: jest.fn().mockImplementation(({ data }) => {
          Object.assign(mockJob, data);
          return Promise.resolve(mockJob);
        }),
      },
      bookingRequest: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve({ ...mockBookingRequest })),
        findFirst: jest.fn().mockImplementation(() => Promise.resolve(null)),
        updateMany: jest.fn().mockImplementation(({ data }) => {
          Object.assign(mockBookingRequest, data);
          return Promise.resolve({ count: 1 });
        }),
        update: jest.fn().mockImplementation(({ data }) => {
          Object.assign(mockBookingRequest, data);
          return Promise.resolve(mockBookingRequest);
        }),
      },
      bookingAccount: {
        update: jest.fn().mockResolvedValue({}),
      },
      bookingMilestone: {
        create: jest.fn().mockResolvedValue({}),
      },
      walletTransaction: {
        findFirst: jest.fn().mockResolvedValue({ amount: 10, type: 'RESERVE', status: 'COMPLETED' }),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'tx-cap-1' }),
      },
      walletLedgerEntry: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      workerMachine: {
        update: jest.fn().mockResolvedValue({}),
      },
      workerActivityLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-1', partnerId: null }),
      },
    };

    walletService = {
      capture: jest.fn().mockResolvedValue({ success: true, message: 'Captured' }),
    };

    accountLockService = {
      releaseLock: jest.fn().mockResolvedValue(true),
    };

    notificationsService = {
      send: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkersService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
        { provide: AccountLockService, useValue: accountLockService },
        { provide: NotificationsService, useValue: notificationsService },
        { provide: SmartMatcherService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
      ],
    }).compile();

    workersService = module.get<WorkersService>(WorkersService);
  });

  it('1. Idempotency: duplicate completeJob call returns 200 without double capture', async () => {
    // First call succeeds
    const res1 = await workersService.completeJob('job-atomic-1', 'w-machine-1', {
      officialBookingReference: 'IVQ26112019410571880889',
      cartId: '1928697091',
      leaseGeneration: 1,
      fencingToken: 'token-123',
      protocolVersion: 'v2.0-fenced',
    });

    expect(res1.success).toBe(true);
    expect(mockJob.status).toBe(BookingStatus.SUCCESS);
    expect(mockBookingRequest.status).toBe(BookingStatus.SUCCESS);
    expect(mockBookingRequest.officialBookingReference).toBe('IVQ26112019410571880889');
    expect(walletService.capture).toHaveBeenCalledTimes(1);

    // Second call with same reference must return 200 idempotent without second capture
    const res2 = await workersService.completeJob('job-atomic-1', 'w-machine-1', {
      officialBookingReference: 'IVQ26112019410571880889',
      cartId: '1928697091',
      leaseGeneration: 1,
      fencingToken: 'token-123',
      protocolVersion: 'v2.0-fenced',
    });

    expect(res2.success).toBe(true);
    expect(res2.message).toContain('already completed');
    expect(walletService.capture).toHaveBeenCalledTimes(1); // Still 1, no duplicate capture!
  });

  it('2. Never discard real pass: accepts completion with valid reference even if lease is stale/expired', async () => {
    // Sent leaseGeneration 1, but job is at leaseGeneration 2
    mockJob.leaseGeneration = 2;

    const res = await workersService.completeJob('job-atomic-1', 'w-machine-1', {
      officialBookingReference: 'IVQ26112019410571880889',
      cartId: '1928697091',
      leaseGeneration: 1, // Stale!
      fencingToken: 'token-123',
      protocolVersion: 'v2.0-fenced',
    });

    // Invariant: Pass is accepted and flagged NEEDS_REVIEW
    expect(res.success).toBe(true);
    expect(mockBookingRequest.status).toBe(BookingStatus.SUCCESS);
    expect(mockBookingRequest.reconciliationStatus).toBe('NEEDS_REVIEW');
    expect(walletService.capture).toHaveBeenCalledTimes(1);
  });

  it('3. Rejects fake or Cart ID reference when lease is stale', async () => {
    mockJob.leaseGeneration = 2;

    // Fake / synthetic reference
    await expect(
      workersService.completeJob('job-atomic-1', 'w-machine-1', {
        officialBookingReference: '1928697091', // Cart ID, not a real pass
        cartId: '1928697091',
        leaseGeneration: 1,
        fencingToken: 'token-123',
        protocolVersion: 'v2.0-fenced',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('4. Rejects conflicting reference on already confirmed booking with 409 Conflict', async () => {
    // Already confirmed with IVQ26112019410571880889
    mockBookingRequest.status = BookingStatus.SUCCESS;
    mockBookingRequest.officialBookingReference = 'IVQ26112019410571880889';

    // Different reference attempted
    await expect(
      workersService.completeJob('job-atomic-1', 'w-machine-1', {
        officialBookingReference: 'IVQ_DIFFERENT_REF_99999',
        cartId: '1928697091',
        leaseGeneration: 1,
        fencingToken: 'token-123',
        protocolVersion: 'v2.0-fenced',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('5. Rejects if another booking already owns this authoritative pass with 409 Conflict', async () => {
    // Another booking in database already holds this pass
    prisma.bookingRequest.findFirst = jest.fn().mockResolvedValue({
      id: 'br-other-user',
      bookingCode: 'TA-10047',
    });

    await expect(
      workersService.completeJob('job-atomic-1', 'w-machine-1', {
        officialBookingReference: 'IVQ26112019410571880889',
        cartId: '1928697091',
        leaseGeneration: 1,
        fencingToken: 'token-123',
        protocolVersion: 'v2.0-fenced',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('6. Atomicity: runs BookingJob, BookingRequest, and Wallet Capture in single transaction', async () => {
    await workersService.completeJob('job-atomic-1', 'w-machine-1', {
      officialBookingReference: 'IVQ26112019410571880889',
      cartId: '1928697091',
      leaseGeneration: 1,
      fencingToken: 'token-123',
      protocolVersion: 'v2.0-fenced',
    });

    // Verified that prisma.$transaction was invoked to wrap all state mutations
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(walletService.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: 'br-atomic-1',
        amount: 10,
      }),
      prisma, // Injected tx client
    );
  });
});
