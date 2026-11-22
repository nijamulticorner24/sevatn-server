import { Test, TestingModule } from '@nestjs/testing';
import { WorkersService } from './workers.service';
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

describe('Capacity Counting, Same-Owner Takeover, Competing Worker, & Already-Completed Suite', () => {
  let workersService: WorkersService;
  let accountLockService: AccountLockService;
  let mockPrisma: any;
  let mockWalletService: any;

  let mockWorkerPC1: any;
  let mockWorkerPC2: any;
  let mockJobs: any[];
  let mockBookings: any[];
  let mockLocks: any[];

  const createBooking = (overrides: Partial<any> = {}) => ({
    id: 'br-100',
    bookingCode: 'TA-10053',
    userId: 'user-1',
    requestedDateStr: '2026-11-28',
    requestedDate: new Date('2026-11-28'),
    route: 'Pamba (Regular Footpath Route)',
    status: BookingStatus.EXECUTION_QUEUED,
    version: 1,
    assignedMachineId: null,
    leaseExpiresAt: null,
    nextCheckAt: null,
    officialBookingReference: null,
    officialReference: null,
    cartId: null,
    reconciliationStatus: null,
    createdAt: new Date('2026-11-20T10:00:00Z'),
    pilgrimCount: 1,
    pilgrims: [{ fullName: 'Ayyappa Devotee', age: 30, gender: 'MALE', idType: 'AADHAAR' }],
    nomineeName: 'Swami Nominee',
    nomineeAge: 35,
    nomineeRelationship: 'BROTHER',
    nomineePhone: '9876543210',
    accountId: 'acc-1',
    account: {
      id: 'acc-1',
      username: '8098697141',
      encryptedPassword: 'enc',
      encryptionIv: 'iv',
      encryptionTag: 'tag',
    },
    ...overrides,
  });

  beforeEach(async () => {
    mockWorkerPC1 = {
      id: 'worker-pc1',
      machineCode: 'PC-001',
      active: true,
      adminStatus: 'ENABLED',
      desiredState: 'RUNNING',
      maxConcurrentJobs: 1,
      currentActiveJobs: 1, // Deliberately drifted/stale counter to verify authoritative self-healing!
      status: WorkerStatus.BUSY,
      lastHeartbeat: new Date(),
      capabilities: ['ACCOUNT_VERIFICATION', 'BOOKING_EXECUTION', 'AVAILABILITY_DISCOVERY'],
    };

    mockWorkerPC2 = {
      id: 'worker-pc2',
      machineCode: 'PC-002',
      active: true,
      adminStatus: 'ENABLED',
      desiredState: 'RUNNING',
      maxConcurrentJobs: 3,
      currentActiveJobs: 1,
      status: WorkerStatus.BUSY,
      lastHeartbeat: new Date(),
      capabilities: ['ACCOUNT_VERIFICATION', 'BOOKING_EXECUTION', 'AVAILABILITY_DISCOVERY'],
    };

    mockJobs = [];
    mockBookings = [];
    mockLocks = [];

    mockWalletService = {
      capture: jest.fn().mockResolvedValue({ success: true, message: 'Captured' }),
      release: jest.fn().mockResolvedValue({ success: true }),
    };

    mockPrisma = {
      workerMachine: {
        findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
          if (where.id === mockWorkerPC1.id) return { ...mockWorkerPC1 };
          if (where.id === mockWorkerPC2.id) return { ...mockWorkerPC2 };
          if (where.id === 'worker-pc1-old') {
            return { ...mockWorkerPC1, id: 'worker-pc1-old', machineCode: 'PC-001' };
          }
          return null;
        }),
        update: jest.fn().mockImplementation(async ({ where, data }: any) => {
          if (where.id === mockWorkerPC1.id) {
            Object.assign(mockWorkerPC1, data);
            return mockWorkerPC1;
          }
          return data;
        }),
      },
      bookingRequest: {
        findMany: jest.fn().mockImplementation(async () => mockBookings.map((b) => ({ ...b }))),
        findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
          const found = mockBookings.find((b) => b.id === where.id);
          if (!found) return null;
          return {
            ...found,
            jobs: mockJobs.filter((j) => j.bookingRequestId === found.id),
          };
        }),
        findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
          return (
            mockBookings.find((b) => {
              if (where?.id?.not && b.id === where.id.not) return false;
              if (where?.officialBookingReference && b.officialBookingReference !== where.officialBookingReference) return false;
              if (where?.status && typeof where.status === 'string' && b.status !== where.status) return false;
              return true;
            }) || null
          );
        }),
        update: jest.fn().mockImplementation(async ({ where, data }: any) => {
          const b = mockBookings.find((x) => x.id === where.id);
          if (b) Object.assign(b, data);
          return b || {};
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      bookingJob: {
        findMany: jest.fn().mockImplementation(async ({ where }: any) => {
          return mockJobs
            .filter((j) => {
              if (where?.workerId && j.workerId !== where.workerId) return false;
              if (where?.jobType && j.jobType !== where.jobType) return false;
              if (where?.status?.notIn && where.status.notIn.includes(j.status)) return false;
              return true;
            })
            .map((j) => ({
              ...j,
              bookingRequest: mockBookings.find((b) => b.id === j.bookingRequestId) || j.bookingRequest || null,
            }));
        }),
        findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
          const found = mockJobs.find((j) => {
            if (where?.bookingRequestId && j.bookingRequestId !== where.bookingRequestId) return false;
            if (where?.jobType && j.jobType !== where.jobType) return false;
            if (where?.workerId && j.workerId !== where.workerId) return false;
            if (where?.status && typeof where.status === 'string' && j.status !== where.status) return false;
            if (where?.OR) {
              const ok = where.OR.some((clause: any) => {
                if (clause.status && typeof clause.status === 'string') return j.status === clause.status;
                if (clause.status?.in) return clause.status.in.includes(j.status);
                return false;
              });
              if (!ok) return false;
            }
            return true;
          });
          if (!found) return null;
          return {
            ...found,
            bookingRequest: mockBookings.find((b) => b.id === found.bookingRequestId) || found.bookingRequest || null,
          };
        }),
        findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
          const found = mockJobs.find((j) => j.id === where.id);
          if (!found) return null;
          return {
            ...found,
            bookingRequest: mockBookings.find((b) => b.id === found.bookingRequestId) || found.bookingRequest || null,
          };
        }),
        create: jest.fn().mockImplementation(async ({ data }: any) => {
          const created = { id: `job-created-${mockJobs.length + 1}`, ...data };
          mockJobs.push(created);
          return created;
        }),
        update: jest.fn().mockImplementation(async ({ where, data }: any) => {
          const j = mockJobs.find((x) => x.id === where.id);
          if (j) Object.assign(j, data);
          return j || {};
        }),
        updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
          const j = mockJobs.find((x) => x.id === where.id);
          if (!j) return { count: 0 };
          const nextGen = data.leaseGeneration?.increment ? (j.leaseGeneration ?? 0) + data.leaseGeneration.increment : data.leaseGeneration ?? j.leaseGeneration;
          const nextAttempt = data.attempt?.increment ? (j.attempt ?? 0) + data.attempt.increment : j.attempt;
          Object.assign(j, { ...data, leaseGeneration: nextGen, attempt: nextAttempt });
          return { count: 1 };
        }),
      },
      accountLock: {
        findUnique: jest.fn().mockImplementation(async ({ where }: any) => mockLocks.find((l) => l.accountId === where.accountId) || null),
        findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
          return (
            mockLocks.find((l) => {
              if (where?.accountId && l.accountId !== where.accountId) return false;
              if (where?.bookingId?.not && l.bookingId === where.bookingId.not) return false;
              return true;
            }) || null
          );
        }),
        create: jest.fn().mockImplementation(async ({ data }: any) => {
          mockLocks.push({ ...data });
          return data;
        }),
        update: jest.fn().mockImplementation(async ({ where, data }: any) => {
          const l = mockLocks.find((x) => x.accountId === where.accountId);
          if (l) Object.assign(l, data);
          return l;
        }),
        deleteMany: jest.fn().mockImplementation(async ({ where }: any) => {
          const before = mockLocks.length;
          mockLocks = mockLocks.filter((l) => {
            if (where?.accountId && l.accountId !== where.accountId) return true;
            if (where?.bookingId && l.bookingId !== where.bookingId) return true;
            if (where?.expiresAt?.lte && l.expiresAt > where.expiresAt.lte) return true;
            return false;
          });
          return { count: before - mockLocks.length };
        }),
      },
      walletTransaction: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tx-res-1', amount: 10, type: 'RESERVE', status: 'COMPLETED' }),
      },
      bookingAttempt: { create: jest.fn().mockResolvedValue({}) },
      workerActivityLog: { create: jest.fn().mockResolvedValue({}) },
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1', partnerId: null }) },
      $queryRaw: jest.fn().mockImplementation(async () => mockBookings.map((b) => ({ id: b.id }))),
      $transaction: jest.fn(async (cb) => cb(mockPrisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkersService,
        AccountLockService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: mockWalletService },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: NotificationsService, useValue: { send: jest.fn().mockResolvedValue({}) } },
        { provide: SmartMatcherService, useValue: { matchAvailabilityEvent: jest.fn() } },
        { provide: BookingStateMachineService, useValue: { transition: jest.fn().mockResolvedValue({}) } },
        { provide: EventsGateway, useValue: { notifyBookingConfirmed: jest.fn() } },
      ],
    }).compile();

    workersService = module.get<WorkersService>(WorkersService);
    accountLockService = module.get<AccountLockService>(AccountLockService);
  });

  describe('1. MAX_CAPACITY excludes stale, WATCHING, COMPLETED, and NEEDS_REVIEW-with-ref jobs', () => {
    it('does NOT count expired-lease, WATCHING, COMPLETED/SUCCESS, or NEEDS_REVIEW-with-ref jobs as active capacity', async () => {
      const targetBr = createBooking({ id: 'br-open', bookingCode: 'TA-10053', requestedDateStr: '2026-11-28' });
      const completedBr = createBooking({ id: 'br-done', bookingCode: 'TA-10051', status: BookingStatus.SUCCESS, officialBookingReference: 'IVQ26112019410571880889' });
      const needsReviewBr = createBooking({ id: 'br-nr', bookingCode: 'TA-10050', status: BookingStatus.EXECUTING, reconciliationStatus: 'NEEDS_REVIEW', officialBookingReference: 'IVQ26112019410571880999' });
      const watchingBr = createBooking({ id: 'br-watch', bookingCode: 'TA-10052', status: BookingStatus.WATCHING, requestedDateStr: '2026-11-26' });

      mockBookings = [targetBr, completedBr, needsReviewBr, watchingBr];
      mockJobs = [
        // 1. Expired WATCHING job owned by PC-001 (the exact production bug!)
        { id: 'job-watching-expired', bookingRequestId: 'br-watch', workerId: 'worker-pc1', status: BookingStatus.WATCHING, leaseExpiresAt: new Date(Date.now() - 60000), leaseGeneration: 1 },
        // 2. Expired EXECUTING job owned by PC-001
        { id: 'job-exec-expired', bookingRequestId: 'br-other', workerId: 'worker-pc1', status: BookingStatus.EXECUTING, leaseExpiresAt: new Date(Date.now() - 5000), leaseGeneration: 1 },
        // 3. COMPLETED/SUCCESS job owned by PC-001
        { id: 'job-completed', bookingRequestId: 'br-done', workerId: 'worker-pc1', status: BookingStatus.SUCCESS, leaseExpiresAt: new Date(Date.now() + 60000), leaseGeneration: 1 },
        // 4. NEEDS_REVIEW with official reference owned by PC-001 (even with unexpired lease!)
        { id: 'job-needs-review-ref', bookingRequestId: 'br-nr', workerId: 'worker-pc1', status: BookingStatus.EXECUTING, leaseExpiresAt: new Date(Date.now() + 60000), leaseGeneration: 1 },
      ];
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'br-open' }]);

      const result = await workersService.matchPendingBooking('worker-pc1', '2026-11-28');
      expect(result.hasJob).toBe(true);
      expect(result.job.bookingCode).toBe('TA-10053');
    });

    it('DOES return MAX_CAPACITY(1/1; jobs=...) when a genuinely RUNNING unexpired job occupies the slot', async () => {
      const targetBr = createBooking({ id: 'br-target', bookingCode: 'TA-TARGET', requestedDateStr: '2026-11-28' });
      const liveOtherBr = createBooking({ id: 'br-live-other', bookingCode: 'TA-LIVE-99', status: BookingStatus.EXECUTING, requestedDateStr: '2026-11-29' });
      mockBookings = [targetBr, liveOtherBr];
      mockJobs = [
        {
          id: 'job-live-99',
          bookingRequestId: 'br-live-other',
          workerId: 'worker-pc1',
          status: BookingStatus.EXECUTING,
          leaseExpiresAt: new Date(Date.now() + 25000), // LIVE unexpired lease!
          leaseGeneration: 1,
        },
      ];
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'br-target' }]);

      const result = await workersService.matchPendingBooking('worker-pc1', '2026-11-28');
      expect(result.hasJob).toBe(false);
      expect((result as any).reason).toMatch(/^MAX_CAPACITY\(1\/1; jobs=job-live-99\[TA-LIVE-99:RUNNING/);
    });
  });

  describe('2. Same-owner takeover (OWN_STALE_LEASE) & Expired lease takeover', () => {
    it('same-owner takeover: re-claims own existing lease (same workerId) with new leaseGeneration and fencingToken', async () => {
      const targetBr = createBooking({
        id: 'br-own-1',
        bookingCode: 'TA-OWN-01',
        status: BookingStatus.EXECUTING,
        assignedMachineId: 'worker-pc1',
        leaseExpiresAt: new Date(Date.now() + 20000), // Unexpired, owned by PC-001 itself!
      });
      mockBookings = [targetBr];
      mockJobs = [
        {
          id: 'job-own-1',
          bookingRequestId: 'br-own-1',
          jobType: JobType.BOOKING_EXECUTION,
          workerId: 'worker-pc1',
          status: BookingStatus.EXECUTING,
          leaseExpiresAt: new Date(Date.now() + 20000),
          leaseGeneration: 2,
          fencingToken: 'old-token-abc',
        },
      ];
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'br-own-1' }]);

      const result = await workersService.matchPendingBooking('worker-pc1', '2026-11-28');
      expect(result.hasJob).toBe(true);
      expect((result as any).takeoverReason).toBe('OWN_STALE_LEASE');
      expect(result.job.id).toBe('job-own-1');
      expect(result.job.leaseGeneration).toBe(3);
      expect(result.job.fencingToken).not.toBe('old-token-abc');
    });

    it('same-owner takeover by machineCode: re-claims lease held by previous registration of PC-001', async () => {
      const targetBr = createBooking({
        id: 'br-own-code',
        bookingCode: 'TA-OWN-CODE',
        status: BookingStatus.EXECUTING,
        assignedMachineId: 'worker-pc1-old',
      });
      mockBookings = [targetBr];
      mockJobs = [
        {
          id: 'job-own-code',
          bookingRequestId: 'br-own-code',
          jobType: JobType.BOOKING_EXECUTION,
          workerId: 'worker-pc1-old', // Same machineCode PC-001!
          status: BookingStatus.EXECUTING,
          leaseExpiresAt: new Date(Date.now() + 20000),
          leaseGeneration: 4,
          fencingToken: 'old-token-xyz',
        },
      ];
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'br-own-code' }]);

      const result = await workersService.matchPendingBooking('worker-pc1', '2026-11-28');
      expect(result.hasJob).toBe(true);
      expect((result as any).takeoverReason).toBe('OWN_STALE_LEASE');
      expect(result.job.leaseGeneration).toBe(5);
      expect(result.job.fencingToken).not.toBe('old-token-xyz');
    });

    it('expired lease takeover: takes over expired lease from another worker with fresh leaseGeneration & fencingToken', async () => {
      const targetBr = createBooking({
        id: 'br-exp-peer',
        bookingCode: 'TA-EXP-PEER',
        status: BookingStatus.EXECUTING,
        assignedMachineId: 'worker-pc2',
        leaseExpiresAt: new Date(Date.now() - 10000), // Expired 10s ago
      });
      mockBookings = [targetBr];
      mockJobs = [
        {
          id: 'job-exp-peer',
          bookingRequestId: 'br-exp-peer',
          jobType: JobType.BOOKING_EXECUTION,
          workerId: 'worker-pc2',
          status: BookingStatus.EXECUTING,
          leaseExpiresAt: new Date(Date.now() - 10000),
          leaseGeneration: 1,
          fencingToken: 'expired-token-1',
        },
      ];
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'br-exp-peer' }]);

      const result = await workersService.matchPendingBooking('worker-pc1', '2026-11-28');
      expect(result.hasJob).toBe(true);
      expect(result.job.id).toBe('job-exp-peer');
      expect(result.job.leaseGeneration).toBe(2);
      expect(result.job.fencingToken).not.toBe('expired-token-1');
    });

    it('claimJob same-owner takeover: re-claims own EXECUTING job when worker is idle (activeJobIds=[])', async () => {
      const targetBr = createBooking({
        id: 'br-claim-own',
        bookingCode: 'TA-CLAIM-OWN',
        status: BookingStatus.EXECUTING,
        assignedMachineId: 'worker-pc1',
      });
      mockBookings = [targetBr];
      mockJobs = [
        {
          id: 'job-claim-own',
          bookingRequestId: 'br-claim-own',
          jobType: JobType.BOOKING_EXECUTION,
          workerId: 'worker-pc1',
          status: BookingStatus.EXECUTING,
          leaseExpiresAt: new Date(Date.now() + 20000),
          leaseGeneration: 1,
          fencingToken: 'stale-own-token',
          account: targetBr.account,
        },
      ];

      const result = await workersService.claimJob('worker-pc1', []);
      expect(result.hasJob).toBe(true);
      expect(result.job.id).toBe('job-claim-own');
      expect(result.job.leaseGeneration).toBe(2);
      expect(result.job.fencingToken).not.toBe('stale-own-token');
    });
  });

  describe('3. Real competing worker returns CLAIMED_BY_OTHER(workerId)', () => {
    it('returns CLAIMED_BY_OTHER(worker-pc2) when worker-pc2 holds a live unexpired lease', async () => {
      const targetBr = createBooking({
        id: 'br-competing',
        bookingCode: 'TA-COMP-01',
        status: BookingStatus.EXECUTION_QUEUED,
      });
      mockBookings = [targetBr];
      mockJobs = [
        {
          id: 'job-competing',
          bookingRequestId: 'br-competing',
          jobType: JobType.BOOKING_EXECUTION,
          workerId: 'worker-pc2',
          status: BookingStatus.EXECUTING,
          leaseExpiresAt: new Date(Date.now() + 25000), // Unexpired live lease!
          leaseGeneration: 1,
        },
      ];
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'br-competing' }]);

      const result = await workersService.matchPendingBooking('worker-pc1', '2026-11-28');
      expect(result.hasJob).toBe(false);
      expect((result as any).reason).toBe('CLAIMED_BY_OTHER(worker-pc2)');
      expect((result as any).ownerWorkerId).toBe('worker-pc2');
    });
  });

  describe('4. Already-completed request protection (ALREADY_COMPLETED)', () => {
    it('refuses re-booking when request already has an official reference and completes it with stored ref', async () => {
      const targetBr = createBooking({
        id: 'br-has-ref',
        bookingCode: 'TA-HAS-REF',
        status: BookingStatus.EXECUTING, // Stuck in EXECUTING despite having ref!
        officialBookingReference: 'IVQ26112019410571880889',
        cartId: '1928697091',
      });
      mockBookings = [targetBr];
      mockJobs = [
        {
          id: 'job-has-ref',
          bookingRequestId: 'br-has-ref',
          jobType: JobType.BOOKING_EXECUTION,
          workerId: 'worker-pc1',
          status: BookingStatus.EXECUTING,
          leaseExpiresAt: new Date(Date.now() - 5000),
          leaseGeneration: 1,
          fencingToken: 'token-ref-1',
        },
      ];
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'br-has-ref' }]);

      const result = await workersService.matchPendingBooking('worker-pc1', '2026-11-28');
      expect(result.hasJob).toBe(false);
      expect((result as any).reason).toBe('ALREADY_COMPLETED(IVQ26112019410571880889)');
      expect(mockWalletService.capture).toHaveBeenCalledTimes(1);
    });

    it('refuses re-booking when existing job is already COMPLETED/SUCCESS', async () => {
      const targetBr = createBooking({
        id: 'br-job-done',
        bookingCode: 'TA-JOB-DONE',
        status: BookingStatus.EXECUTION_QUEUED,
      });
      mockBookings = [targetBr];
      mockJobs = [
        {
          id: 'job-already-success',
          bookingRequestId: 'br-job-done',
          jobType: JobType.BOOKING_EXECUTION,
          workerId: 'worker-pc1',
          status: BookingStatus.SUCCESS,
          leaseGeneration: 1,
        },
      ];
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'br-job-done' }]);

      const result = await workersService.matchPendingBooking('worker-pc1', '2026-11-28');
      expect(result.hasJob).toBe(false);
      expect((result as any).reason).toBe('ALREADY_COMPLETED(COMPLETED)');
    });
  });

  describe('5. Account Lock: reclaims finished/stale locks while enforcing 1 active booking per account', () => {
    it('reclaims account lock held by a finished or lease-expired job so new booking proceeds', async () => {
      const finishedBr = createBooking({
        id: 'br-old-finished',
        bookingCode: 'TA-OLD',
        status: BookingStatus.EXECUTING,
        officialBookingReference: 'IVQ26112019410571880889', // Finished with official ref!
      });
      const newBr = createBooking({
        id: 'br-new-open',
        bookingCode: 'TA-NEW',
        status: BookingStatus.EXECUTION_QUEUED,
      });
      mockBookings = [finishedBr, newBr];
      mockLocks = [
        {
          accountId: 'acc-1',
          bookingId: 'br-old-finished',
          workerId: 'worker-pc1',
          leaseGeneration: 1,
          lockedAt: new Date(),
          expiresAt: new Date(Date.now() + 60000), // Lock TTL still unexpired, but holding booking is FINISHED!
        },
      ];
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'br-new-open' }]);

      const result = await workersService.matchPendingBooking('worker-pc1', '2026-11-28');
      expect(result.hasJob).toBe(true);
      expect(result.job.bookingCode).toBe('TA-NEW');
    });

    it('returns ACCOUNT_BUSY(jobId) when a different genuinely RUNNING unexpired job holds the account lock', async () => {
      const liveBr = createBooking({
        id: 'br-live-acc',
        bookingCode: 'TA-LIVE-ACC',
        status: BookingStatus.EXECUTING,
        requestedDateStr: '2026-11-29',
      });
      const waitingBr = createBooking({
        id: 'br-waiting-acc',
        bookingCode: 'TA-WAIT-ACC',
        status: BookingStatus.EXECUTION_QUEUED,
        requestedDateStr: '2026-11-28',
      });
      mockBookings = [liveBr, waitingBr];
      mockJobs = [
        {
          id: 'job-live-acc-holder',
          bookingRequestId: 'br-live-acc',
          workerId: 'worker-pc2',
          status: BookingStatus.EXECUTING,
          leaseExpiresAt: new Date(Date.now() + 30000), // Live unexpired lease on worker-pc2!
          leaseGeneration: 1,
        },
      ];
      mockLocks = [
        {
          accountId: 'acc-1',
          bookingId: 'br-live-acc',
          workerId: 'worker-pc2',
          leaseGeneration: 1,
          lockedAt: new Date(),
          expiresAt: new Date(Date.now() + 60000),
        },
      ];
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 'br-waiting-acc' }]);

      const result = await workersService.matchPendingBooking('worker-pc1', '2026-11-28');
      expect(result.hasJob).toBe(false);
      expect((result as any).reason).toBe('ACCOUNT_BUSY(job-live-acc-holder)');
    });
  });
});
