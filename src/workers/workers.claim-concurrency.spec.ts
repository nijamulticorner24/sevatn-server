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
      { id: 'w-1', machineCode: 'PC-001', status: WorkerStatus.IDLE, active: true, desiredState: 'RUNNING', machineToken: 'tok-1' },
      { id: 'w-2', machineCode: 'PC-002', status: WorkerStatus.IDLE, active: true, desiredState: 'RUNNING', machineToken: 'tok-2' },
      { id: 'w-3', machineCode: 'PC-003', status: WorkerStatus.IDLE, active: true, desiredState: 'RUNNING', machineToken: 'tok-3' },
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
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return mockWorkerMachines.find(w => (where.id && w.id === where.id) || (where.machineCode && w.machineCode === where.machineCode) || (where.machineToken && w.machineToken === where.machineToken)) || null;
        }),
        findMany: jest.fn().mockImplementation(() => {
          return mockWorkerMachines.map(w => ({ ...w }));
        }),
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
      expect((winner as any).job.id).toBe('job-1');
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

  describe('CRITICAL: Super Admin Worker Push / Stop / Resume Execution Controls', () => {
    it('1. verifies an unpaired worker cannot start', async () => {
      mockWorkerMachines.push({
        id: 'w-unpaired',
        machineCode: 'PC-UNPAIRED',
        active: false,
        machineToken: null,
        pairingCode: 'TA-9999',
        desiredState: 'STOPPED',
      });

      await expect(
        workersService.startWorker('w-unpaired', { id: 'admin-1' })
      ).rejects.toThrow(BadRequestException);
    });

    it('2. verifies an approved but stopped worker cannot claim new jobs', async () => {
      // Worker 1 is stopped
      await workersService.stopWorker('w-1', { id: 'admin-1' });

      const claimResult = await workersService.claimJob('w-1');
      expect(claimResult.hasJob).toBe(false);
      expect((claimResult as any).stopped).toBe(true);
      expect((claimResult as any).desiredState).toBe('STOPPED');
      expect(mockBookingJobs[0].workerId).toBeNull();
    });

    it('3. verifies stop immediately prevents further job claims and lease acquisition on server', async () => {
      // Ensure job is queued
      expect(mockBookingJobs[0].status).toBe(BookingStatus.QUEUED);

      // Super Admin stops w-2
      const stopRes = await workersService.stopWorker('w-2', { id: 'admin-1' });
      expect(stopRes.machine.desiredState).toBe('STOPPED');

      // w-2 attempts to claim
      const claimRes = await workersService.claimJob('w-2');
      expect(claimRes.hasJob).toBe(false);
      expect((claimRes as any).stopped).toBe(true);
    });

    it('4. verifies in-flight operations follow safe recovery path (transitions to STOPPING without aborting)', async () => {
      // w-1 claims and is actively executing job-1
      const claimRes = await workersService.claimJob('w-1');
      expect(claimRes.hasJob).toBe(true);

      const worker1 = mockWorkerMachines.find(w => w.id === 'w-1');
      worker1.currentJobId = 'job-1';

      // Super Admin requests STOP while job is in-flight
      const stopRes = await workersService.stopWorker('w-1', { id: 'admin-1' });
      expect(stopRes.machine.desiredState).toBe('STOPPING');

      // Verify in-flight job was NOT aborted or marked failed; remains EXECUTING
      expect(mockBookingJobs[0].status).toBe(BookingStatus.EXECUTING);

      // Heartbeat while still executing preserves STOPPING
      const hb1 = await workersService.handleHeartbeat('w-1', {
        status: WorkerStatus.BUSY,
        currentJobId: 'job-1',
      });
      expect(hb1.desiredState).toBe('STOPPING');
      expect(hb1.executionPermitted).toBe(false);

      // Job completes normally
      await workersService.completeJob('job-1', 'w-1', { officialReference: 'IVQ-CONFIRMED-99' });

      // Worker sends heartbeat with no active jobs -> transitions to STOPPED
      const hb2 = await workersService.handleHeartbeat('w-1', {
        status: WorkerStatus.IDLE,
        currentJobId: undefined,
      });
      expect(hb2.desiredState).toBe('STOPPED');
      expect(worker1.desiredState).toBe('STOPPED');
    });

    it('5. verifies resume re-enables only the intended worker', async () => {
      // Stop both w-1 and w-2
      await workersService.stopWorker('w-1', { id: 'admin-1' });
      await workersService.stopWorker('w-2', { id: 'admin-1' });

      // Resume only w-1
      const resumeRes = await workersService.resumeWorker('w-1', { id: 'admin-1' });
      expect(resumeRes.machine.desiredState).toBe('RUNNING');

      // w-1 can claim
      const claim1 = await workersService.claimJob('w-1');
      expect(claim1.hasJob).toBe(true);

      // w-2 remains stopped and cannot claim
      const claim2 = await workersService.claimJob('w-2');
      expect(claim2.hasJob).toBe(false);
      expect((claim2 as any).stopped).toBe(true);
    });

    it('6. verifies restarting the worker does not override persisted stopped state', async () => {
      // Stopped by admin
      await workersService.stopWorker('w-1', { id: 'admin-1' });

      // Worker process restarts and checks pairing status
      const pairingStatus = await workersService.checkPairingStatus('PC-001');
      expect(pairingStatus.paired).toBe(true);
      expect(pairingStatus.desiredState).toBe('STOPPED');

      // Worker sends initial heartbeat after restart
      const hb = await workersService.handleHeartbeat('w-1', { status: WorkerStatus.IDLE });
      expect(hb.desiredState).toBe('STOPPED');
      expect(hb.executionPermitted).toBe(false);
    });

    it('7. verifies repeated or concurrent start/stop commands are idempotent', async () => {
      // Multiple stops
      const stop1 = await workersService.stopWorker('w-1', { id: 'admin-1' });
      const stop2 = await workersService.stopWorker('w-1', { id: 'admin-1' });
      expect(stop1.machine.desiredState).toBe('STOPPED');
      expect(stop2.machine.desiredState).toBe('STOPPED');

      // Multiple starts
      const start1 = await workersService.startWorker('w-1', { id: 'admin-1' });
      const start2 = await workersService.startWorker('w-1', { id: 'admin-1' });
      expect(start1.machine.desiredState).toBe('RUNNING');
      expect(start2.machine.desiredState).toBe('RUNNING');
    });

    it('8. verifies a disconnected worker is not falsely reported as stopped', async () => {
      // w-3 is running, but heartbeat is 60 seconds old
      const worker3 = mockWorkerMachines.find(w => w.id === 'w-3');
      worker3.desiredState = 'RUNNING';
      worker3.lastHeartbeat = new Date(Date.now() - 60000);

      const all = await workersService.getAllWorkers();
      const w3Info = all.find(w => w.id === 'w-3');
      expect(w3Info.status).toBe(WorkerStatus.OFFLINE);
      expect(w3Info.isDisconnected).toBe(true);
      expect(w3Info.desiredState).toBe('RUNNING'); // Desired state is preserved; not falsely reported as stopped
    });

    it('9. verifies one worker controls do not affect another worker', async () => {
      // Stop w-1
      await workersService.stopWorker('w-1', { id: 'admin-1' });

      const w1 = mockWorkerMachines.find(w => w.id === 'w-1');
      const w2 = mockWorkerMachines.find(w => w.id === 'w-2');

      expect(w1.desiredState).toBe('STOPPED');
      expect(w2.desiredState).toBe('RUNNING'); // w-2 unaffected
    });

    it('10. verifies no booking, ledger, wallet, or reconciliation regressions occur', async () => {
      // Stopped worker claiming fails cleanly without modifying booking request or wallet
      await workersService.stopWorker('w-1', { id: 'admin-1' });
      await workersService.claimJob('w-1');

      expect(mockBookingRequests[0].status).toBe(BookingStatus.QUEUED);
      expect(releasedWalletHolds.length).toBe(0);
    });
  });
});
