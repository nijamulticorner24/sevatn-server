import { Test, TestingModule } from '@nestjs/testing';
import { WorkersService, LEASE_TTL_MS } from './workers.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccountLockService } from '../availability/account-lock.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { BookingStateMachineService } from '../bookings/booking-state-machine.service';
import { SmartAllocatorService } from './smart-allocator.service';
import { EventsGateway } from '../events/events.gateway';
import { BookingStatus, JobType, WorkerStatus } from '@prisma/client';
import {
  CLAIMABLE_OPEN_REQUEST_STATUSES,
  TERMINAL_OR_EXCLUDED_BOOKING_STATUSES,
  isDateInPast,
  isRouteMatching,
  getTodayISTDateString,
} from '../common/booking-status.constants';

describe('Sniper Match-Pending & Shared Status Specification Suite', () => {
  let workersService: WorkersService;
  let mockPrisma: any;
  let mockAccountLockService: any;

  const mockWorker = {
    id: 'worker-node-1',
    machineCode: 'WM-001',
    active: true,
    adminStatus: 'ENABLED',
    desiredState: 'RUNNING',
    capabilities: ['BOOKING_EXECUTION'],
    maxConcurrentJobs: 3,
    currentActiveJobs: 0,
    status: WorkerStatus.IDLE,
  };

  const createMockBooking = (overrides: Partial<any> = {}) => ({
    id: 'br-open-1',
    bookingCode: 'TA-OPEN-100',
    requestedDateStr: '2026-11-28',
    requestedDate: new Date('2026-11-28'),
    route: 'Pamba (Regular Footpath Route)',
    status: BookingStatus.PENDING,
    assignedMachineId: null,
    nextCheckAt: null,
    createdAt: new Date('2026-11-01T10:00:00Z'),
    pilgrimCount: 1,
    pilgrims: [{ fullName: 'Ayyappa Devotee', age: 30, gender: 'MALE', idType: 'AADHAAR' }],
    nomineeName: 'Swami Nominee',
    nomineeAge: 35,
    nomineeRelationship: 'BROTHER',
    nomineePhone: '9876543210',
    account: {
      id: 'acc-1',
      username: 'devotee@sabarimala.org',
      encryptedPassword: 'enc',
      encryptionIv: 'iv',
      encryptionTag: 'tag',
    },
    ...overrides,
  });

  beforeEach(async () => {
    mockAccountLockService = {
      acquireLock: jest.fn().mockResolvedValue(true),
      isLocked: jest.fn().mockResolvedValue(false),
      releaseLock: jest.fn().mockResolvedValue(true),
    };

    mockPrisma = {
      workerMachine: {
        findUnique: jest.fn().mockResolvedValue(mockWorker),
        update: jest.fn().mockResolvedValue(mockWorker),
      },
      bookingRequest: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
      bookingJob: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'job-created-1',
          status: BookingStatus.EXECUTING,
          leaseGeneration: 1,
          fencingToken: 'fence-1',
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      bookingAccount: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      accountLock: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      walletTransaction: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tx-1', type: 'RESERVE', status: 'COMPLETED' }),
        count: jest.fn().mockResolvedValue(1),
      },
      workerActivityLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(async (cb) => cb(mockPrisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: { capture: jest.fn(), release: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: NotificationsService, useValue: { send: jest.fn() } },
        { provide: AccountLockService, useValue: mockAccountLockService },
        { provide: SmartMatcherService, useValue: { matchAvailabilityEvent: jest.fn() } },
        { provide: BookingStateMachineService, useValue: { transition: jest.fn().mockResolvedValue({}) } },
        { provide: SmartAllocatorService, useValue: { reconcileWorkerCapacity: jest.fn() } },
        { provide: EventsGateway, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    workersService = module.get<WorkersService>(WorkersService);
  });

  describe('1. Shared Claimable Open Status Definition', () => {
    const claimableStatuses = [
      BookingStatus.PENDING,
      BookingStatus.FAST_BOOKING_QUEUED,
      BookingStatus.WATCHING,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.WAITING_FOR_ACCOUNT,
      BookingStatus.RETRYABLE_FAILURE,
    ];

    test.each(claimableStatuses)(
      'matchPendingBooking accepts and claims candidate in %s status',
      async (status) => {
        const booking = createMockBooking({ status });
        mockPrisma.$queryRaw.mockResolvedValue([{ id: booking.id }]);
        mockPrisma.bookingRequest.findUnique.mockResolvedValue(booking);

        const result = await workersService.matchPendingBooking('worker-node-1', '2026-11-28');
        expect(result.hasJob).toBe(true);
        expect(result.job).toBeDefined();
        expect(result.job.id).toBe('job-created-1');
      },
    );

    it('rejects candidate in terminal or non-claimable status (e.g. CANCELLED)', async () => {
      const cancelledBooking = createMockBooking({ status: BookingStatus.CANCELLED });
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.bookingRequest.findMany.mockResolvedValue([cancelledBooking]);

      const result = await workersService.matchPendingBooking('worker-node-1', '2026-11-28');
      expect(result.hasJob).toBe(false);
      expect((result as any).reason).toBe('STATUS_NOT_CLAIMABLE(CANCELLED)');
    });
  });

  describe('2. Atomic Job Creation & Stale Job Takeover', () => {
    it('creates job atomically when the claimable booking has no job row', async () => {
      const booking = createMockBooking({ status: BookingStatus.EXECUTION_QUEUED });
      mockPrisma.$queryRaw.mockResolvedValue([{ id: booking.id }]);
      mockPrisma.bookingRequest.findUnique.mockResolvedValue(booking);
      mockPrisma.bookingJob.findFirst.mockResolvedValue(null);

      const result = await workersService.matchPendingBooking('worker-node-1', '2026-11-28');
      expect(result.hasJob).toBe(true);
      expect(mockPrisma.bookingJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            bookingRequestId: booking.id,
            workerId: 'worker-node-1',
            status: BookingStatus.EXECUTING,
            leaseGeneration: 1,
          }),
        }),
      );
    });

    it('takes over stale job with expired lease from another worker', async () => {
      const booking = createMockBooking({ status: BookingStatus.EXECUTION_QUEUED });
      const staleJob = {
        id: 'job-stale-1',
        bookingRequestId: booking.id,
        workerId: 'worker-dead-99',
        status: BookingStatus.EXECUTING,
        leaseExpiresAt: new Date(Date.now() - 5000), // Expired 5s ago
        leaseGeneration: 2,
      };

      mockPrisma.$queryRaw.mockResolvedValue([{ id: booking.id }]);
      mockPrisma.bookingRequest.findUnique.mockResolvedValue(booking);
      mockPrisma.bookingJob.findFirst.mockResolvedValue(staleJob);
      mockPrisma.bookingJob.updateMany.mockResolvedValue({ count: 1 });

      const result = await workersService.matchPendingBooking('worker-node-1', '2026-11-28');
      expect(result.hasJob).toBe(true);
      expect(result.job.id).toBe('job-stale-1');
      expect(result.job.leaseGeneration).toBe(3);
      expect(mockPrisma.bookingJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'job-stale-1' }),
          data: expect.objectContaining({
            workerId: 'worker-node-1',
            status: BookingStatus.EXECUTING,
          }),
        }),
      );
    });

    it('takes over stale job whose owner worker is dead/unresponsive', async () => {
      const booking = createMockBooking({ status: BookingStatus.EXECUTION_QUEUED });
      const deadWorkerJob = {
        id: 'job-dead-owner-1',
        bookingRequestId: booking.id,
        workerId: 'worker-crashed',
        status: BookingStatus.EXECUTING,
        leaseExpiresAt: new Date(Date.now() + 60000), // Unexpired lease
        leaseGeneration: 1,
      };

      // Owner machine is unresponsive (heartbeat > 45s ago)
      mockPrisma.workerMachine.findUnique.mockImplementation(async (args: any) => {
        if (args.where.id === 'worker-crashed') {
          return { id: 'worker-crashed', active: false, adminStatus: 'DISABLED', lastHeartbeat: new Date(Date.now() - 90000) };
        }
        return mockWorker;
      });

      mockPrisma.$queryRaw.mockResolvedValue([{ id: booking.id }]);
      mockPrisma.bookingRequest.findUnique.mockResolvedValue(booking);
      mockPrisma.bookingJob.findFirst.mockResolvedValue(deadWorkerJob);
      mockPrisma.bookingJob.updateMany.mockResolvedValue({ count: 1 });

      const result = await workersService.matchPendingBooking('worker-node-1', '2026-11-28');
      expect(result.hasJob).toBe(true);
      expect(result.job.id).toBe('job-dead-owner-1');
    });
  });

  describe('3. Specific Reason Codes', () => {
    it('returns PAST_DATE when target date is before today', async () => {
      const result = await workersService.matchPendingBooking('worker-node-1', '2020-01-01');
      expect(result.hasJob).toBe(false);
      expect((result as any).reason).toBe('PAST_DATE');
    });

    it('returns NONE_FOR_DATE when no booking request exists for date', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.bookingRequest.findMany.mockResolvedValue([]);
      mockPrisma.bookingAccount.findMany.mockResolvedValue([]);

      const result = await workersService.matchPendingBooking('worker-node-1', '2026-11-28');
      expect(result.hasJob).toBe(false);
      expect((result as any).reason).toBe('NONE_FOR_DATE');
    });

    it('returns ROUTE_MISMATCH when route does not match candidate', async () => {
      const booking = createMockBooking({ route: 'Erumely (Via Forest Route)' });
      mockPrisma.$queryRaw.mockResolvedValue([{ id: booking.id }]);
      mockPrisma.bookingRequest.findUnique.mockResolvedValue(booking);
      mockPrisma.bookingRequest.findMany.mockResolvedValue([booking]);

      const result = await workersService.matchPendingBooking('worker-node-1', '2026-11-28', 'Pamba - Marakkoottam - 4 Kms');
      expect(result.hasJob).toBe(false);
      expect((result as any).reason).toBe('ROUTE_MISMATCH');
    });

    it('returns IN_COOLDOWN when candidate nextCheckAt is in the future', async () => {
      const booking = createMockBooking({ nextCheckAt: new Date(Date.now() + 60000) });
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.bookingRequest.findMany.mockResolvedValue([booking]);

      const result = await workersService.matchPendingBooking('worker-node-1', '2026-11-28');
      expect(result.hasJob).toBe(false);
      expect((result as any).reason).toBe('IN_COOLDOWN');
    });

    it('returns ACCOUNT_BUSY when candidate account is held by another active booking', async () => {
      const booking = createMockBooking();
      mockPrisma.$queryRaw.mockResolvedValue([{ id: booking.id }]);
      mockPrisma.bookingRequest.findUnique.mockResolvedValue(booking);
      mockAccountLockService.isLocked.mockResolvedValue(true);
      mockPrisma.accountLock.findFirst.mockResolvedValue({ bookingId: 'br-prior-999' });

      const result = await workersService.matchPendingBooking('worker-node-1', '2026-11-28');
      expect(result.hasJob).toBe(false);
      expect((result as any).reason).toBe('ACCOUNT_BUSY(br-prior-999)');
    });

    it('returns CLAIMED_BY_OTHER(workerId) when active lease is held by another healthy worker and unexpired', async () => {
      const booking = createMockBooking();
      const activeJob = {
        id: 'job-active-live',
        bookingRequestId: booking.id,
        workerId: 'worker-peer-2',
        status: BookingStatus.EXECUTING,
        leaseExpiresAt: new Date(Date.now() + 25000), // unexpired
        leaseGeneration: 1,
      };

      mockPrisma.workerMachine.findUnique.mockImplementation(async (args: any) => {
        if (args.where.id === 'worker-peer-2') {
          return { id: 'worker-peer-2', active: true, adminStatus: 'ENABLED', lastHeartbeat: new Date() };
        }
        return mockWorker;
      });

      mockPrisma.$queryRaw.mockResolvedValue([{ id: booking.id }]);
      mockPrisma.bookingRequest.findUnique.mockResolvedValue(booking);
      mockPrisma.bookingJob.findFirst.mockResolvedValue(activeJob);

      const result = await workersService.matchPendingBooking('worker-node-1', '2026-11-28');
      expect(result.hasJob).toBe(false);
      expect((result as any).reason).toBe('CLAIMED_BY_OTHER(worker-peer-2)');
    });

    it('returns CLAIMED_BY_OTHER when atomic CAS update encounters concurrent claim race', async () => {
      const booking = createMockBooking();
      const existingJob = {
        id: 'job-race-1',
        bookingRequestId: booking.id,
        workerId: null,
        status: BookingStatus.QUEUED,
        leaseGeneration: 1,
      };

      mockPrisma.$queryRaw.mockResolvedValue([{ id: booking.id }]);
      mockPrisma.bookingRequest.findUnique.mockResolvedValue(booking);
      mockPrisma.bookingJob.findFirst.mockResolvedValue(existingJob);
      mockPrisma.bookingJob.updateMany.mockResolvedValue({ count: 0 }); // Raced

      const result = await workersService.matchPendingBooking('worker-node-1', '2026-11-28');
      expect(result.hasJob).toBe(false);
      expect((result as any).reason).toMatch(/^CLAIMED_BY_OTHER\(/);
    });

    it('returns NO_RESERVATION when customer booking has no wallet hold', async () => {
      const booking = createMockBooking({ isWatching: false, isAutoGrab: false, hasReservation: false });
      mockPrisma.$queryRaw.mockResolvedValue([{ id: booking.id }]);
      mockPrisma.bookingRequest.findUnique.mockResolvedValue(booking);

      const result = await workersService.matchPendingBooking('worker-node-1', '2026-11-28');
      expect(result.hasJob).toBe(false);
      expect((result as any).reason).toBe('NO_RESERVATION');
    });
  });

  describe('4. Date Logic: Past vs Today vs Future', () => {
    it('accepts today date when portal verified it as available', async () => {
      const todayIST = getTodayISTDateString();
      const booking = createMockBooking({
        requestedDateStr: todayIST,
        requestedDate: new Date(todayIST),
      });

      mockPrisma.$queryRaw.mockResolvedValue([{ id: booking.id }]);
      mockPrisma.bookingRequest.findUnique.mockResolvedValue(booking);

      const result = await workersService.matchPendingBooking('worker-node-1', todayIST);
      expect(result.hasJob).toBe(true);
      expect(result.job.requestedDate).toBe(todayIST);
    });

    it('rejects past date with PAST_DATE reason', async () => {
      const result = await workersService.matchPendingBooking('worker-node-1', '2024-01-01');
      expect(result.hasJob).toBe(false);
      expect((result as any).reason).toBe('PAST_DATE');
    });
  });
});
