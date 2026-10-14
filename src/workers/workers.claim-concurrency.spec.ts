import { Test, TestingModule } from '@nestjs/testing';
import { WorkersService } from './workers.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AccountLockService } from '../availability/account-lock.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BookingStatus, JobType, WorkerStatus } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';

describe('WorkersService Concurrency & Financial Quarantine Invariants', () => {
  let workersService: WorkersService;
  let prisma: PrismaService;
  let walletService: WalletService;
  let accountLockService: AccountLockService;

  // In-memory data structures
  let mockWorkerMachines: any[] = [];
  let mockBookingJobs: any[] = [];
  let mockBookingRequests: any[] = [];
  let mockAccounts: any[] = [];
  let releasedWalletHolds: any[] = [];

  beforeEach(async () => {
    mockWorkerMachines = [
      { id: 'w-1', machineCode: 'PC-001', status: WorkerStatus.IDLE, active: true, machineToken: 'tok-1' },
      { id: 'w-2', machineCode: 'PC-002', status: WorkerStatus.IDLE, active: true, machineToken: 'tok-2' },
      { id: 'w-3', machineCode: 'PC-003', status: WorkerStatus.IDLE, active: true, machineToken: 'tok-3' },
    ];
    mockAccounts = [
      { id: 'acc-1', username: 'devotee1@example.com', encryptedPassword: 'enc', encryptionIv: 'iv', encryptionTag: 'tag', status: 'VERIFIED' }
    ];
    mockBookingRequests = [
      {
        id: 'br-1',
        bookingCode: 'BK-1001',
        userId: 'user-devotee-1',
        user: { email: 'devotee@example.com' },
        status: BookingStatus.QUEUED,
        accountId: 'acc-1',
        pilgrimCount: 1,
        pilgrims: [{ fullName: 'Devotee A' }],
      }
    ];
    mockBookingJobs = [
      {
        id: 'job-1',
        bookingRequestId: 'br-1',
        bookingRequest: mockBookingRequests[0],
        accountId: 'acc-1',
        account: mockAccounts[0],
        jobType: JobType.BOOKING_EXECUTION,
        status: BookingStatus.QUEUED,
        workerId: null,
        attempt: 0,
        maxAttempts: 3,
        leaseExpiresAt: null,
      }
    ];
    releasedWalletHolds = [];

    const mockPrismaService = {
      $transaction: jest.fn().mockImplementation(async (callback) => {
        return await callback(mockPrismaService);
      }),
      bookingJob: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          const found = mockBookingJobs.find(j => {
            if (where.jobType && j.jobType !== where.jobType) return false;
            if (where.status && j.status !== where.status) return false;
            if (where.OR) {
              const matchesOr = where.OR.some((clause: any) => {
                if (clause.status?.in) return clause.status.in.includes(j.status);
                if (clause.status) return clause.status === j.status;
                return false;
              });
              if (!matchesOr) return false;
            }
            return true;
          });
          return found ? { ...found } : null;
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return mockBookingJobs.find(j => j.id === where.id) || null;
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          const job = mockBookingJobs.find(j => {
            if (j.id !== where.id) return false;
            if (j.status !== where.status) return false;
            if (where.OR) {
              const now = new Date();
              const matchesOwner = where.OR.some((clause: any) => {
                if (clause.workerId === null && j.workerId === null) return true;
                if (clause.workerId && clause.workerId === j.workerId) return true;
                if (clause.leaseExpiresAt?.lte && j.leaseExpiresAt && j.leaseExpiresAt <= now) return true;
                return false;
              });
              if (!matchesOwner) return false;
            }
            return true;
          });
          if (job) {
            Object.assign(job, data);
            return { count: 1 };
          }
          return { count: 0 };
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const job = mockBookingJobs.find(j => j.id === where.id);
          if (job) Object.assign(job, data);
          return job;
        }),
      },
      bookingRequest: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return mockBookingRequests.find(b => b.id === where.id) || null;
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const br = mockBookingRequests.find(b => b.id === where.id);
          if (br) Object.assign(br, data);
          return br;
        }),
      },
      workerMachine: {
        update: jest.fn().mockImplementation(({ where, data }) => {
          const wm = mockWorkerMachines.find(w => w.id === where.id);
          if (wm) Object.assign(wm, data);
          return wm;
        }),
      },
      bookingAttempt: {
        create: jest.fn().mockResolvedValue({ id: 'att-1' }),
      },
      bookingAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'aud-1' }),
      },
      systemAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'sys-1' }),
      },
      bookingAccount: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return mockAccounts.find(a => a.id === where.id) || null;
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const a = mockAccounts.find(acc => acc.id === where.id);
          if (a) Object.assign(a, data);
          return a;
        }),
      },
      walletTransaction: {
        findFirst: jest.fn().mockResolvedValue({ amount: 100 }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ partnerId: null }),
      },
    };

    const mockWalletService = {
      release: jest.fn().mockImplementation(async (dto) => {
        releasedWalletHolds.push(dto);
        return { success: true };
      }),
      capture: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockAccountLockService = {
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    };

    const mockAuditService = {
      log: jest.fn().mockResolvedValue({ id: 'aud-1' }),
    };

    const mockNotificationsService = {
      send: jest.fn().mockResolvedValue({ success: true }),
    };

    const mockSmartMatcherService = {
      returnToPendingOnSlotLoss: jest.fn().mockResolvedValue({ success: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkersService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: WalletService, useValue: mockWalletService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: NotificationsService, useValue: mockNotificationsService },
        { provide: AccountLockService, useValue: mockAccountLockService },
        { provide: SmartMatcherService, useValue: mockSmartMatcherService },
      ],
    }).compile();

    workersService = module.get<WorkersService>(WorkersService);
    prisma = module.get<PrismaService>(PrismaService);
    walletService = module.get<WalletService>(WalletService);
    accountLockService = module.get<AccountLockService>(AccountLockService);
  });

  describe('FIND-001: Atomic Job Claiming & Concurrency', () => {
    it('grants ownership to exactly one worker when multiple workers compete for 1 queued job', async () => {
      // 10 concurrent claim calls
      const claims = await Promise.all([
        workersService.claimJob('w-1'),
        workersService.claimJob('w-2'),
        workersService.claimJob('w-3'),
        workersService.claimJob('w-1'),
        workersService.claimJob('w-2'),
        workersService.claimJob('w-3'),
        workersService.claimJob('w-1'),
        workersService.claimJob('w-2'),
        workersService.claimJob('w-3'),
        workersService.claimJob('w-1'),
      ]);

      const successfulClaims = claims.filter(c => c.hasJob === true);
      const rejectedClaims = claims.filter(c => c.hasJob === false);

      expect(successfulClaims.length).toBe(1);
      expect(rejectedClaims.length).toBe(9);

      // Verify the winning job is marked EXECUTING with winning worker ID
      const winner = successfulClaims[0];
      expect(winner.job.id).toBe('job-1');
      expect(mockBookingJobs[0].status).toBe(BookingStatus.EXECUTING);
    });
  });

  describe('FIND-002: Unknown Outcome & Wallet Hold Quarantine', () => {
    it('does NOT release wallet hold on UNKNOWN_RESULT and quarantines booking in REQUIRES_HUMAN', async () => {
      // Claim job
      await workersService.claimJob('w-1');

      // Worker reports UNKNOWN_RESULT
      const failDto = {
        status: 'UNKNOWN_RESULT' as any,
        errorCode: 'VERIFICATION_PENDING',
        errorMessage: 'Submitted but confirmation modal not visible before timeout',
      };

      const result = await workersService.failJob('job-1', 'w-1', failDto);

      expect(result.success).toBe(true);
      // Booking must be quarantined in REQUIRES_HUMAN
      expect(mockBookingRequests[0].status).toBe(BookingStatus.REQUIRES_HUMAN);

      // Wallet hold MUST NOT be released!
      expect(walletService.release).not.toHaveBeenCalled();
      expect(releasedWalletHolds.length).toBe(0);
    });

    it('releases wallet hold once on confirmed failure', async () => {
      // Claim job
      await workersService.claimJob('w-1');

      const failDto = {
        status: BookingStatus.FAILED,
        errorCode: 'LOGIN_FAILED',
        errorMessage: 'Invalid username/password on official portal',
      };

      const result = await workersService.failJob('job-1', 'w-1', failDto);

      expect(result.success).toBe(true);
      expect(mockBookingRequests[0].status).toBe(BookingStatus.FAILED);
      expect(walletService.release).toHaveBeenCalledWith(
        expect.objectContaining({ bookingId: 'br-1', amount: 100 })
      );
      expect(releasedWalletHolds.length).toBe(1);
    });
  });

  describe('FIND-004: Reject Synthetic Booking References', () => {
    it('rejects synthetic booking reference (SAB-2026-...) with BadRequestException', async () => {
      await workersService.claimJob('w-1');

      const syntheticDto = {
        officialReference: 'SAB-2026-BK-1001',
        confirmationData: {},
        note: 'Pass confirmed',
      };

      await expect(
        workersService.completeJob('job-1', 'w-1', syntheticDto)
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects short / invalid references', async () => {
      await workersService.claimJob('w-1');

      const shortDto = {
        officialReference: 'ABC',
        confirmationData: {},
      };

      await expect(
        workersService.completeJob('job-1', 'w-1', shortDto)
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts authoritative external reference and completes job', async () => {
      await workersService.claimJob('w-1');

      const validDto = {
        officialReference: 'IVQ9827364501',
        confirmationData: { ref: 'IVQ9827364501' },
      };

      const res = await workersService.completeJob('job-1', 'w-1', validDto);
      expect(res.success).toBe(true);
      expect(mockBookingRequests[0].status).toBe(BookingStatus.SUCCESS);
    });
  });
});
