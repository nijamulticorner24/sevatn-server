import { Test, TestingModule } from '@nestjs/testing';
import { AvailabilityService } from './availability.service';
import { AccountLockService } from './account-lock.service';
import { SmartAllocatorService } from '../workers/smart-allocator.service';
import { AdminService } from '../admin/admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { DiscoverySchedulerService } from './discovery-scheduler.service';
import { SmartMatcherService } from './smart-matcher.service';
import { WalletService } from '../wallet/wallet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BookingStatus, JobType, WorkerStatus } from '@prisma/client';

describe('Discovery, Reconciler, Account Locks, and Clear Queues Suite', () => {
  let availabilityService: AvailabilityService;
  let accountLockService: AccountLockService;
  let smartAllocatorService: SmartAllocatorService;
  let adminService: AdminService;

  let mockBookings: any[] = [];
  let mockJobs: any[] = [];
  let mockLocks: any[] = [];
  let mockWorkers: any[] = [];
  let mockOpportunities: any[] = [];

  const mockPrisma: any = {
    bookingRequest: {
      findMany: jest.fn().mockImplementation(async (args: any) => {
        let list = [...mockBookings];
        if (args?.where?.status?.in) {
          list = list.filter((b) => args.where.status.in.includes(b.status));
        }
        if (args?.where?.status?.notIn) {
          list = list.filter((b) => !args.where.status.notIn.includes(b.status));
        }
        return list;
      }),
      findUnique: jest.fn().mockImplementation(async (args: any) => {
        return mockBookings.find((b) => b.id === args.where.id) || null;
      }),
      update: jest.fn().mockImplementation(async (args: any) => {
        const idx = mockBookings.findIndex((b) => b.id === args.where.id);
        if (idx !== -1) {
          Object.assign(mockBookings[idx], args.data);
          return mockBookings[idx];
        }
        return null;
      }),
      updateMany: jest.fn().mockImplementation(async (args: any) => {
        let count = 0;
        for (const b of mockBookings) {
          if (args.where.id && b.id !== args.where.id) continue;
          if (args.where.status?.in && !args.where.status.in.includes(b.status)) continue;
          Object.assign(b, args.data);
          count++;
        }
        return { count };
      }),
    },
    bookingJob: {
      findMany: jest.fn().mockImplementation(async (args: any) => {
        let list = [...mockJobs];
        if (args?.where?.status?.in) {
          list = list.filter((j) => args.where.status.in.includes(j.status));
        }
        if (args?.where?.status && !args?.where?.status?.in) {
          list = list.filter((j) => j.status === args.where.status);
        }
        if (args?.where?.leaseExpiresAt?.lte) {
          list = list.filter((j) => j.leaseExpiresAt && j.leaseExpiresAt <= args.where.leaseExpiresAt.lte);
        }
        return list;
      }),
      findUnique: jest.fn().mockImplementation(async (args: any) => {
        return mockJobs.find((j) => j.id === args.where.id) || null;
      }),
      findFirst: jest.fn().mockImplementation(async (args: any) => {
        return mockJobs.find((j) => {
          if (args?.where?.bookingRequestId && j.bookingRequestId !== args.where.bookingRequestId) return false;
          return true;
        }) || null;
      }),
      create: jest.fn().mockImplementation(async (args: any) => {
        const newJob = { id: `job-${mockJobs.length + 1}`, ...args.data };
        mockJobs.push(newJob);
        // Link to booking
        const br = mockBookings.find((b) => b.id === args.data.bookingRequestId);
        if (br) {
          if (!br.jobs) br.jobs = [];
          br.jobs.push(newJob);
        }
        return newJob;
      }),
      update: jest.fn().mockImplementation(async (args: any) => {
        const idx = mockJobs.findIndex((j) => j.id === args.where.id);
        if (idx !== -1) {
          Object.assign(mockJobs[idx], args.data);
          return mockJobs[idx];
        }
        return null;
      }),
      updateMany: jest.fn().mockImplementation(async (args: any) => {
        let count = 0;
        for (const j of mockJobs) {
          if (args.where.id && j.id !== args.where.id) continue;
          if (args.where.status?.notIn && args.where.status.notIn.includes(j.status)) continue;
          Object.assign(j, args.data);
          count++;
        }
        return { count };
      }),
    },
    accountLock: {
      findUnique: jest.fn().mockImplementation(async (args: any) => {
        return mockLocks.find((l) => l.accountId === args.where.accountId) || null;
      }),
      findFirst: jest.fn().mockImplementation(async (args: any) => {
        return mockLocks.find((l) => {
          if (args.where.accountId && l.accountId !== args.where.accountId) return false;
          if (args.where.bookingId?.not && l.bookingId === args.where.bookingId.not) return false;
          return true;
        }) || null;
      }),
      findMany: jest.fn().mockImplementation(async () => [...mockLocks]),
      create: jest.fn().mockImplementation(async (args: any) => {
        const exists = mockLocks.find((l) => l.accountId === args.data.accountId);
        if (exists) throw new Error('Unique constraint failed on accountId');
        mockLocks.push({ ...args.data });
        return args.data;
      }),
      update: jest.fn().mockImplementation(async (args: any) => {
        const idx = mockLocks.findIndex((l) => l.accountId === args.where.accountId);
        if (idx !== -1) {
          Object.assign(mockLocks[idx], args.data);
          return mockLocks[idx];
        }
        return null;
      }),
      updateMany: jest.fn().mockImplementation(async (args: any) => {
        let count = 0;
        for (const l of mockLocks) {
          if (args.where.accountId && l.accountId !== args.where.accountId) continue;
          if (args.where.expiresAt?.lte && l.expiresAt > args.where.expiresAt.lte) continue;
          Object.assign(l, args.data);
          count++;
        }
        return { count };
      }),
      delete: jest.fn().mockImplementation(async (args: any) => {
        const idx = mockLocks.findIndex((l) => l.accountId === args.where.accountId);
        if (idx !== -1) {
          return mockLocks.splice(idx, 1)[0];
        }
        return null;
      }),
      deleteMany: jest.fn().mockImplementation(async (args: any) => {
        const initial = mockLocks.length;
        if (!args || !args.where || Object.keys(args.where).length === 0) {
          mockLocks = [];
          return { count: initial };
        }
        mockLocks = mockLocks.filter((l) => {
          if (args.where.accountId && l.accountId === args.where.accountId) {
            if (args.where.expiresAt?.lte && l.expiresAt > args.where.expiresAt.lte) return true;
            return false;
          }
          if (args.where.expiresAt?.lte && l.expiresAt <= args.where.expiresAt.lte) return false;
          return true;
        });
        return { count: initial - mockLocks.length };
      }),
    },
    workerMachine: {
      findMany: jest.fn().mockImplementation(async () => [...mockWorkers]),
      findUnique: jest.fn().mockImplementation(async (args: any) => {
        return mockWorkers.find((w) => w.id === args.where.id) || null;
      }),
      update: jest.fn().mockImplementation(async (args: any) => {
        const idx = mockWorkers.findIndex((w) => w.id === args.where.id);
        if (idx !== -1) {
          Object.assign(mockWorkers[idx], args.data);
          return mockWorkers[idx];
        }
        return null;
      }),
    },
    availabilityOpportunity: {
      deleteMany: jest.fn().mockImplementation(async (args: any) => {
        const count = mockOpportunities.length;
        mockOpportunities = [];
        return { count };
      }),
    },
    jobAllocationLog: {
      create: jest.fn().mockResolvedValue({ id: 'log-1' }),
    },
  };

  const mockDiscoveryScheduler = {
    ensureSchedule: jest.fn().mockImplementation(async (date: string, route: string) => ({
      demandKey: `${date}:PAMBA`,
      date,
      route,
      status: 'AVAILABLE',
      isDue: true,
      lastCheckedAt: null,
      nextCheckAt: new Date(Date.now() - 1000),
      lockedBy: null,
    })),
  };

  const mockWalletService = {
    release: jest.fn().mockResolvedValue({ success: true }),
  };

  const mockNotifications = {
    send: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    mockBookings = [];
    mockJobs = [];
    mockLocks = [];
    mockWorkers = [
      {
        id: 'worker-1',
        machineCode: 'M-1',
        active: true,
        status: WorkerStatus.ONLINE,
        lastHeartbeat: new Date(),
      },
    ];
    mockOpportunities = [];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AvailabilityService,
        AccountLockService,
        SmartAllocatorService,
        AdminService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: DiscoverySchedulerService, useValue: mockDiscoveryScheduler },
        { provide: SmartMatcherService, useValue: {} },
        { provide: WalletService, useValue: mockWalletService },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();

    availabilityService = module.get<AvailabilityService>(AvailabilityService);
    accountLockService = module.get<AccountLockService>(AccountLockService);
    smartAllocatorService = module.get<SmartAllocatorService>(SmartAllocatorService);
    adminService = module.get<AdminService>(AdminService);
  });

  describe('1. Discovery Engine with All Open Statuses', () => {
    it('includes bookings across PENDING, WATCHING, EXECUTION_QUEUED, WAITING_FOR_ACCOUNT, and RETRYABLE_FAILURE', async () => {
      mockBookings = [
        { id: 'b-1', bookingCode: 'BK-1', status: BookingStatus.PENDING, requestedDateStr: '2026-11-25', route: 'Pamba', nextCheckAt: null },
        { id: 'b-2', bookingCode: 'BK-2', status: BookingStatus.WATCHING, requestedDateStr: '2026-11-26', route: 'Pamba', nextCheckAt: null },
        { id: 'b-3', bookingCode: 'BK-3', status: BookingStatus.EXECUTION_QUEUED, requestedDateStr: '2026-11-27', route: 'Pamba', nextCheckAt: null },
        { id: 'b-4', bookingCode: 'BK-4', status: BookingStatus.WAITING_FOR_ACCOUNT, requestedDateStr: '2026-11-28', route: 'Pamba', nextCheckAt: null },
        { id: 'b-5', bookingCode: 'BK-5', status: BookingStatus.RETRYABLE_FAILURE, requestedDateStr: '2026-11-29', route: 'Pamba', nextCheckAt: null },
      ];

      const demand = await availabilityService.getDemandDates();

      expect(demand.length).toBe(5);
      const dates = demand.map((d) => d.date);
      expect(dates).toContain('2026-11-25');
      expect(dates).toContain('2026-11-26');
      expect(dates).toContain('2026-11-27');
      expect(dates).toContain('2026-11-28');
      expect(dates).toContain('2026-11-29');
    });

    it('identifies and excludes open requests in cooldown with IN_COOLDOWN reason', async () => {
      const futureCooldown = new Date(Date.now() + 60000);
      mockBookings = [
        { id: 'b-active', bookingCode: 'BK-ACT', status: BookingStatus.EXECUTION_QUEUED, requestedDateStr: '2026-11-27', route: 'Pamba', nextCheckAt: null },
        { id: 'b-cooldown', bookingCode: 'BK-COOL', status: BookingStatus.RETRYABLE_FAILURE, requestedDateStr: '2026-11-30', route: 'Pamba', nextCheckAt: futureCooldown },
      ];

      const demand = await availabilityService.getDemandDates();

      expect(demand.length).toBe(1);
      expect(demand[0].date).toBe('2026-11-27');
    });
  });

  describe('2. Reconciler Recreate & Reset Logic', () => {
    it('recreates a missing QUEUED job for an EXECUTION_QUEUED booking request', async () => {
      mockBookings = [
        {
          id: 'br-orphan',
          bookingCode: 'BK-ORPHAN-1',
          status: BookingStatus.EXECUTION_QUEUED,
          accountId: 'acc-1',
          jobs: [],
        },
      ];

      const res = await smartAllocatorService.recoverStaleLeases();

      expect(res.recreatedJobsCount).toBe(1);
      expect(mockJobs.length).toBe(1);
      expect(mockJobs[0].bookingRequestId).toBe('br-orphan');
      expect(mockJobs[0].status).toBe(BookingStatus.QUEUED);
      expect(mockJobs[0].workerId).toBeNull();
    });

    it('resets EXECUTION_QUEUED booking to PENDING if job recreation fails', async () => {
      mockBookings = [
        {
          id: 'br-fail',
          bookingCode: 'BK-FAIL-1',
          status: BookingStatus.EXECUTION_QUEUED,
          accountId: 'acc-1',
          jobs: [],
        },
      ];
      mockPrisma.bookingJob.create.mockRejectedValueOnce(new Error('DB connection failure'));

      const res = await smartAllocatorService.recoverStaleLeases();

      expect(mockBookings[0].status).toBe(BookingStatus.PENDING);
      expect(res.details).toEqual(
        expect.arrayContaining([expect.stringContaining('Reset EXECUTION_QUEUED booking #BK-FAIL-1 to PENDING')])
      );
    });

    it('requeues a WAITING_FOR_ACCOUNT booking when its devotee account is free', async () => {
      mockBookings = [
        {
          id: 'br-wait',
          bookingCode: 'BK-WAIT-1',
          status: BookingStatus.WAITING_FOR_ACCOUNT,
          accountId: 'acc-free-1',
          jobs: [],
        },
      ];
      // Account has no locks
      mockLocks = [];

      const res = await smartAllocatorService.recoverStaleLeases();

      expect(res.requeuedAccountsCount).toBe(1);
      expect(mockBookings[0].status).toBe(BookingStatus.QUEUED);
      expect(mockJobs.length).toBe(1);
      expect(mockJobs[0].status).toBe(BookingStatus.QUEUED);
    });

    it('returns a RETRYABLE_FAILURE job to QUEUED when nextRetryAt/cooldown has passed', async () => {
      const pastCooldown = new Date(Date.now() - 10000);
      mockBookings = [
        {
          id: 'br-ret',
          bookingCode: 'BK-RET-1',
          status: BookingStatus.RETRYABLE_FAILURE,
          nextCheckAt: pastCooldown,
        },
      ];
      mockJobs = [
        {
          id: 'job-ret-1',
          bookingRequestId: 'br-ret',
          status: BookingStatus.RETRYABLE_FAILURE,
          workerId: 'worker-old',
          bookingRequest: mockBookings[0],
        },
      ];

      const res = await smartAllocatorService.recoverStaleLeases();

      expect(res.retryableRequeuedCount).toBe(1);
      expect(mockJobs[0].status).toBe(BookingStatus.QUEUED);
      expect(mockJobs[0].workerId).toBeNull();
      expect(mockBookings[0].status).toBe(BookingStatus.QUEUED);
    });
  });

  describe('3. Account Lock TTL & Automatic Reclamation', () => {
    it('automatically reclaims an expired lock when acquiring for a new booking', async () => {
      const pastExpiry = new Date(Date.now() - 5000);
      mockLocks = [
        {
          accountId: 'acc-1',
          bookingId: 'br-old',
          expiresAt: pastExpiry,
          lockedAt: new Date(Date.now() - 65000),
        },
      ];

      const acquired = await accountLockService.acquireLock('acc-1', 'br-new', 'worker-1', 60);

      expect(acquired).toBe(true);
      const lock = mockLocks.find((l) => l.accountId === 'acc-1');
      expect(lock).toBeDefined();
      expect(lock.bookingId).toBe('br-new');
    });

    it('never holds a lock for a job whose booking request has reached terminal status', async () => {
      mockBookings = [
        { id: 'br-term', bookingCode: 'BK-TERM', status: BookingStatus.CANCELLED },
      ];
      mockLocks = [
        {
          accountId: 'acc-2',
          bookingId: 'br-term',
          expiresAt: new Date(Date.now() + 50000), // unexpired timer but dead booking
        },
      ];

      const locked = await accountLockService.isLocked('acc-2');

      expect(locked).toBe(false);
      // Stale lock was removed
      expect(mockLocks.find((l) => l.accountId === 'acc-2')).toBeUndefined();
    });
  });

  describe('4. Clear Queues Leaves Consistent State', () => {
    it('cancels all active requests, active jobs, releases wallet holds, and deletes locks', async () => {
      mockBookings = [
        { id: 'b-active-1', status: BookingStatus.EXECUTION_QUEUED, userId: 'u-1' },
        { id: 'b-active-2', status: BookingStatus.WAITING_FOR_ACCOUNT, userId: 'u-2' },
        { id: 'b-done', status: BookingStatus.COMPLETED, userId: 'u-3' },
      ];
      mockJobs = [
        { id: 'j-1', status: BookingStatus.EXECUTING, workerId: 'worker-1' },
        { id: 'j-2', status: BookingStatus.QUEUED, workerId: null },
        { id: 'j-3', status: BookingStatus.COMPLETED, workerId: null },
      ];
      mockLocks = [
        { accountId: 'acc-1', bookingId: 'b-active-1', expiresAt: new Date(Date.now() + 10000) },
      ];
      mockOpportunities = [{ id: 'opp-1', status: 'AVAILABLE' }];

      await adminService.clearAllQueues({ id: 'admin-1', name: 'SuperAdmin' });

      // All active bookings cancelled
      expect(mockBookings.find((b) => b.id === 'b-active-1')?.status).toBe(BookingStatus.CANCELLED);
      expect(mockBookings.find((b) => b.id === 'b-active-2')?.status).toBe(BookingStatus.CANCELLED);
      // Completed booking untouched
      expect(mockBookings.find((b) => b.id === 'b-done')?.status).toBe(BookingStatus.COMPLETED);

      // All active jobs cancelled
      expect(mockJobs.find((j) => j.id === 'j-1')?.status).toBe(BookingStatus.CANCELLED);
      expect(mockJobs.find((j) => j.id === 'j-2')?.status).toBe(BookingStatus.CANCELLED);
      expect(mockJobs.find((j) => j.id === 'j-3')?.status).toBe(BookingStatus.COMPLETED);

      // Wallet holds released for active bookings
      expect(mockWalletService.release).toHaveBeenCalledTimes(2);

      // Locks & opportunities deleted
      expect(mockLocks.length).toBe(0);
      expect(mockOpportunities.length).toBe(0);
    });
  });
});
