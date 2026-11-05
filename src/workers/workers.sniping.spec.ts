import { Test, TestingModule } from '@nestjs/testing';
import { WorkersService } from './workers.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AccountLockService } from '../availability/account-lock.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BookingStatus, JobType, WorkerStatus } from '@prisma/client';

describe('WorkersService Cancellation Sniping & Multi-Worker Safe Claiming Suite', () => {
  let workersService: WorkersService;
  let mockPrisma: any;

  beforeEach(async () => {
    const mockWorker = {
      id: 'worker-1',
      machineCode: 'PC-SNIPER-01',
      status: WorkerStatus.ONLINE,
      active: true,
      adminStatus: 'ENABLED',
      maxConcurrentJobs: 1,
      currentActiveJobs: 0,
    };

    const mockBooking = {
      id: 'br-101',
      bookingCode: 'TA-10101',
      requestedDateStr: '2026-11-25',
      requestedDate: new Date('2026-11-25'),
      route: 'Pamba (Regular Footpath Route)',
      status: BookingStatus.PENDING,
      assignedMachineId: null,
      createdAt: new Date('2026-11-01T10:00:00Z'),
      pilgrimCount: 1,
      pilgrims: [{ fullName: 'Swami Pilgrim', age: 30, gender: 'MALE', idType: 'AADHAAR' }],
      nomineeName: 'Swami Nominee',
      nomineeAge: 35,
      nomineeRelationship: 'BROTHER',
      nomineePhone: '9876543210',
      account: {
        id: 'acc-1',
        username: 'devotee@test.com',
        encryptedPassword: 'enc',
        encryptionIv: 'iv',
        encryptionTag: 'tag',
      },
    };

    mockPrisma = {
      workerMachine: {
        findUnique: jest.fn().mockResolvedValue(mockWorker),
        update: jest.fn().mockResolvedValue(mockWorker),
      },
      bookingRequest: {
        findMany: jest.fn().mockResolvedValue([
          { requestedDateStr: '2026-11-25', requestedDate: new Date('2026-11-25') },
          { requestedDateStr: '2026-11-26', requestedDate: new Date('2026-11-26') },
          { requestedDateStr: '2026-11-25', requestedDate: new Date('2026-11-25') },
        ]),
        findUnique: jest.fn().mockResolvedValue(mockBooking),
        findFirst: jest.fn().mockResolvedValue(mockBooking),
        update: jest.fn().mockResolvedValue(mockBooking),
      },
      bookingJob: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'job-101',
          bookingRequestId: 'br-101',
          status: BookingStatus.EXECUTING,
          leaseGeneration: 1,
          fencingToken: 'f-1',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      workerActivityLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'br-101' }]),
      $transaction: jest.fn((cb) => cb(mockPrisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: { capture: jest.fn(), release: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: NotificationsService, useValue: { send: jest.fn() } },
        { provide: AccountLockService, useValue: { acquireLock: jest.fn().mockResolvedValue(true), isLocked: jest.fn().mockResolvedValue(false) } },
        { provide: SmartMatcherService, useValue: { returnToPendingOnSlotLoss: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    workersService = module.get<WorkersService>(WorkersService);
  });

  it('Task 1: getPendingDates returns unique deduplicated pending dates', async () => {
    const res = await workersService.getPendingDates();
    expect(res).toBeDefined();
    expect(res.dates).toEqual(['2026-11-25', '2026-11-26']);
  });

  it('Task 2 & 3: matchPendingBooking claims oldest pending booking with FOR UPDATE SKIP LOCKED query', async () => {
    const claimResult = await workersService.matchPendingBooking('worker-1', '2026-11-25');

    expect(claimResult.hasJob).toBe(true);
    expect(claimResult.job).toBeDefined();
    expect(claimResult.job.bookingCode).toBe('TA-10101');
    expect(claimResult.job.requestedDate).toBe('2026-11-25');

    // Verified raw query with row-level lock was attempted
    expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    // Verified worker machine status updated to BUSY
    expect(mockPrisma.workerMachine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'worker-1' },
        data: expect.objectContaining({ status: WorkerStatus.BUSY }),
      })
    );
  });

  it('Task 3: Multi-worker safe claiming: returns hasJob=false when another worker already claimed the slot', async () => {
    // Simulate peer worker already claimed the row (SKIP LOCKED returns 0 rows)
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.bookingRequest.findFirst.mockResolvedValue(null);
    mockPrisma.bookingAccount = {
      findMany: jest.fn().mockResolvedValue([]),
    };

    const peerResult = await workersService.matchPendingBooking('worker-1', '2026-11-25');
    expect(peerResult.hasJob).toBe(false);
    expect(peerResult.job).toBeNull();
  });

  it('Stage 2 Watchlist Match: converts generic WATCHLIST booking to EXECUTING when no PENDING booking exists', async () => {
    const mockWatchBooking = {
      id: 'br-watch-201',
      bookingCode: 'TA-WATCH-55555',
      requestedDateStr: '2026-11-28',
      requestedDate: new Date('2026-11-28'),
      route: 'Pamba (Regular Footpath Route)',
      status: BookingStatus.WATCHING,
      isWatching: true,
      assignedMachineId: null,
      createdAt: new Date('2026-11-01T10:00:00Z'),
      pilgrimCount: 1,
      pilgrims: [],
      nomineeName: 'Temple Seva',
      nomineeAge: 35,
      nomineeRelationship: 'Relative',
      nomineePhone: '9876543210',
      account: {
        id: 'acc-verified-1',
        username: 'official@sabarimala.org',
        encryptedPassword: 'enc',
        encryptionIv: 'iv',
        encryptionTag: 'tag',
      },
    };

    // Stage 1 (Customer PENDING) returns empty
    // Stage 2 (Watchlist) returns mockWatchBooking
    mockPrisma.$queryRaw
      .mockResolvedValueOnce([]) // Stage 1
      .mockResolvedValueOnce([{ id: 'br-watch-201' }]); // Stage 2

    mockPrisma.bookingRequest.findUnique.mockResolvedValueOnce(mockWatchBooking);

    const matchResult = await workersService.matchPendingBooking('worker-1', '2026-11-28');

    expect(matchResult.hasJob).toBe(true);
    expect(matchResult.job).toBeDefined();
    expect(matchResult.job.bookingCode).toBe('TA-WATCH-55555');
    expect(matchResult.job.requestedDate).toBe('2026-11-28');
    expect(matchResult.job.dispatchSource).toBe('SNIPER_WATCHLIST');
    expect(mockPrisma.workerMachine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'worker-1' },
        data: expect.objectContaining({ status: WorkerStatus.BUSY }),
      })
    );
  });

  it('Stage 3 Auto-Grab Mode: creates reserved TA-GRAB booking on verified account when neither PENDING nor WATCHLIST exists', async () => {
    // Stage 1 returns empty, Stage 2 returns empty
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.bookingRequest.findFirst.mockResolvedValue(null);

    const verifiedAccount = {
      id: 'acc-official-1',
      userId: 'admin-user-1',
      username: 'temple-admin@sabarimala.org',
      encryptedPassword: 'enc-pass',
      encryptionIv: 'enc-iv',
      encryptionTag: 'enc-tag',
      status: 'VERIFIED',
    };

    mockPrisma.bookingAccount = {
      findMany: jest.fn().mockResolvedValue([verifiedAccount]),
    };

    const mockGrabBooking = {
      id: 'br-grab-999',
      bookingCode: 'TA-GRAB-1234',
      requestedDateStr: '2026-11-30',
      requestedDate: new Date('2026-11-30'),
      route: 'Pamba (Regular Footpath Route)',
      status: BookingStatus.EXECUTING,
      isWatching: true,
      isAutoGrab: true,
      assignedMachineId: 'worker-1',
      pilgrimCount: 1,
      pilgrims: [],
      nomineeName: 'Temple Seva',
      nomineeAge: 35,
      nomineeRelationship: 'Relative',
      nomineePhone: '9876543210',
      account: verifiedAccount,
    };

    mockPrisma.bookingRequest.create = jest.fn().mockResolvedValue(mockGrabBooking);
    mockPrisma.bookingJob.create = jest.fn().mockResolvedValue({
      id: 'job-grab-999',
      bookingRequestId: 'br-grab-999',
      status: BookingStatus.EXECUTING,
      leaseGeneration: 1,
      fencingToken: 'f-grab-1',
    });

    const grabResult = await workersService.matchPendingBooking('worker-1', '2026-11-30');

    expect(grabResult.hasJob).toBe(true);
    expect(grabResult.job).toBeDefined();
    expect(grabResult.job.dispatchSource).toBe('SNIPER_AUTO_GRAB');
    expect(grabResult.job.bookingCode).toContain('TA-GRAB-');
    expect(mockPrisma.bookingRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isAutoGrab: true,
          isWatching: true,
          status: BookingStatus.EXECUTING,
        }),
      })
    );
  });

  it('Watchlist Management: createWatchlistEntry and getWatchlist create and query active watchlist', async () => {
    mockPrisma.user = {
      findFirst: jest.fn().mockResolvedValue({ id: 'super-admin-id', role: 'SUPER_ADMIN' }),
    };

    mockPrisma.bookingRequest.findFirst.mockResolvedValueOnce(null); // not existing yet
    const createdWatchlist = {
      id: 'br-watch-new',
      bookingCode: 'TA-WATCH-77777',
      requestedDateStr: '2026-12-05',
      requestedDate: new Date('2026-12-05'),
      route: 'Pamba (Regular Footpath Route)',
      status: BookingStatus.WATCHING,
      isWatching: true,
    };
    mockPrisma.bookingRequest.create = jest.fn().mockResolvedValue(createdWatchlist);

    const createRes = await workersService.createWatchlistEntry('2026-12-05');
    expect(createRes.watchlist.bookingCode).toBe('TA-WATCH-77777');
    expect(mockPrisma.bookingRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestedDateStr: '2026-12-05',
          status: BookingStatus.WATCHING,
          isWatching: true,
        }),
      })
    );

    mockPrisma.bookingRequest.findMany = jest.fn().mockResolvedValue([createdWatchlist]);
    const watchlist = await workersService.getWatchlist();
    expect(watchlist).toHaveLength(1);
    expect(watchlist[0].bookingCode).toBe('TA-WATCH-77777');
  });

  it('Task 4: claimJob excludes CANCELLED bookings and does not transition CANCELLED to EXECUTING', async () => {
    // Simulate pre-allocated job with a CANCELLED booking (like TA-10063)
    mockPrisma.bookingJob.findFirst.mockResolvedValueOnce({
      id: 'job-cancelled-1',
      jobType: JobType.BOOKING_EXECUTION,
      bookingRequestId: 'br-cancelled-1',
      bookingRequest: {
        id: 'br-cancelled-1',
        bookingCode: 'TA-10063',
        status: BookingStatus.CANCELLED,
      },
    });

    const result = await workersService.claimJob('worker-1');
    expect(result.hasJob).toBe(false);
    expect(mockPrisma.bookingJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-cancelled-1' },
        data: expect.objectContaining({ status: BookingStatus.CANCELLED }),
      })
    );
  });

  it('Task 4: claimJob excludes bookings that are in backoff (nextCheckAt in the future)', async () => {
    // Simulate fallback query finding a booking that is currently in backoff
    const futureDate = new Date(Date.now() + 60000);
    mockPrisma.bookingJob.findFirst.mockResolvedValueOnce(null); // No pre-allocated
    mockPrisma.bookingJob.findMany = jest.fn().mockResolvedValueOnce([]); // No candidate jobs
    mockPrisma.$queryRaw.mockResolvedValueOnce([]); // Raw SQL filters out nextCheckAt > now
    mockPrisma.bookingRequest.findFirst.mockResolvedValueOnce(null);

    const result = await workersService.claimJob('worker-1');
    expect(result.hasJob).toBe(false);
  });

  it('One Job Per Booking: claimJob reuses existing BookingJob without creating a new one', async () => {
    mockPrisma.bookingJob.findFirst.mockImplementation((args: any) => {
      if (args?.where?.bookingRequestId) {
        return Promise.resolve({
          id: 'existing-job-1',
          bookingRequestId: 'br-101',
          attempt: 1,
          leaseGeneration: 1,
          fencingToken: 'f-1',
        });
      }
      return Promise.resolve(null);
    });

    mockPrisma.bookingJob.update.mockImplementation(({ where, data }: any) => {
      return Promise.resolve({
        id: where.id,
        bookingRequestId: 'br-101',
        ...data,
      });
    });

    mockPrisma.bookingJob.findMany = jest.fn().mockResolvedValueOnce([]); // No candidate jobs
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 'br-101' }]); // Fallback raw SQL returns br-101

    const result = await workersService.claimJob('worker-1');

    expect(result.hasJob).toBe(true);
    expect(result.job.id).toBe('existing-job-1');
    // Ensure update was called on existing job
    expect(mockPrisma.bookingJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'existing-job-1' },
        data: expect.objectContaining({
          status: BookingStatus.EXECUTING,
          workerId: 'worker-1',
        }),
      })
    );
    // Ensure create was NOT called
    expect(mockPrisma.bookingJob.create).not.toHaveBeenCalled();
  });

  it('Backoff on BookingRequest: failJob updates BookingRequest.nextCheckAt to NOW() + 5 minutes', async () => {
    mockPrisma.bookingJob.findUnique = jest.fn().mockResolvedValue({
      id: 'job-fail-1',
      bookingRequestId: 'br-fail-1',
      workerId: 'worker-1',
      leaseGeneration: 1,
      fencingToken: 'f-1',
      bookingRequest: { id: 'br-fail-1', bookingCode: 'TA-10066', accountId: null },
    });

    const beforeCall = Date.now();
    await workersService.failJob('job-fail-1', 'worker-1', {
      status: BookingStatus.DATE_UNAVAILABLE,
      errorCode: 'DATE_UNAVAILABLE',
      errorMessage: 'Date is full',
    });

    expect(mockPrisma.bookingRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'br-fail-1' },
        data: expect.objectContaining({
          nextCheckAt: expect.any(Date),
        }),
      })
    );

    const updateCalls = mockPrisma.bookingRequest.update.mock.calls;
    const lastCall = updateCalls[updateCalls.length - 1][0];
    const scheduledTime = lastCall.data.nextCheckAt.getTime();
    const minExpected = beforeCall + 4.9 * 60 * 1000;
    const maxExpected = beforeCall + 5.1 * 60 * 1000;
    expect(scheduledTime).toBeGreaterThanOrEqual(minExpected);
    expect(scheduledTime).toBeLessThanOrEqual(maxExpected);
  });
});

