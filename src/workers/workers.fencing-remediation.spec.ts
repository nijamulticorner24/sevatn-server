import { Test, TestingModule } from '@nestjs/testing';
import { WorkersService } from './workers.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AccountLockService } from '../availability/account-lock.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BookingStateMachineService } from '../bookings/booking-state-machine.service';
import { BookingStatus, JobType, WorkerStatus } from '@prisma/client';
import { ConflictException, ForbiddenException } from '@nestjs/common';

describe('WorkersService Fencing & Lease Remediation (Phase 3)', () => {
  let workersService: WorkersService;
  let prisma: any;
  let walletService: any;
  let accountLockService: any;
  let stateMachine: any;

  let mockJob: any;
  let mockBookingRequest: any;

  beforeEach(async () => {
    mockBookingRequest = {
      id: 'br-fencing-1',
      bookingCode: 'BK-FENCE-001',
      status: BookingStatus.EXECUTING,
      version: 2,
      assignedMachineId: 'w-active-1',
      userId: 'user-centre-1',
      pilgrimCount: 2,
    };

    mockJob = {
      id: 'job-fencing-1',
      jobType: JobType.BOOKING_EXECUTION,
      bookingRequestId: 'br-fencing-1',
      bookingRequest: mockBookingRequest,
      accountId: 'acc-1',
      workerId: 'w-active-1',
      status: BookingStatus.WORKER_ASSIGNED,
      leaseGeneration: 3,
      fencingToken: 'fnc_job-fencing-1_gen3_w-active',
      version: 3,
    };

    prisma = {
      $transaction: jest.fn().mockImplementation(async (cb) => cb(prisma)),
      bookingJob: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve({ ...mockJob })),
        update: jest.fn().mockImplementation(({ data }) => {
          Object.assign(mockJob, data);
          return Promise.resolve(mockJob);
        }),
        updateMany: jest.fn().mockImplementation(() => Promise.resolve({ count: 1 })),
      },
      bookingRequest: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve({ ...mockBookingRequest })),
        update: jest.fn().mockImplementation(({ data }) => {
          Object.assign(mockBookingRequest, data);
          return Promise.resolve(mockBookingRequest);
        }),
      },
      workerMachine: {
        findUnique: jest.fn().mockResolvedValue({ id: 'w-active-1', machineCode: 'PC-ACTIVE-1' }),
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

    stateMachine = {
      transition: jest.fn().mockResolvedValue({ ...mockBookingRequest, status: BookingStatus.SUCCESS }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkersService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: walletService },
        { provide: AccountLockService, useValue: accountLockService },
        { provide: BookingStateMachineService, useValue: stateMachine },
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
          useValue: {
            send: jest.fn().mockResolvedValue({}),
            sendBookingNotification: jest.fn().mockResolvedValue({}),
          },
        },
      ],
    }).compile();

    workersService = module.get<WorkersService>(WorkersService);
  });

  describe('1. Lease Generation & Fencing Token Guards in completeJob', () => {
    it('REJECTS completion from a stale worker whose leaseGeneration is older than current', async () => {
      // Current job has leaseGeneration: 3. Worker reports with generation: 2.
      await expect(
        workersService.completeJob('job-fencing-1', 'w-active-1', {
          officialReference: 'OFFICIAL-PASS-999',
          leaseGeneration: 2, // STALE!
          fencingToken: 'fnc_job-fencing-1_gen2_old',
        }),
      ).rejects.toThrow(ConflictException);

      expect(stateMachine.transition).not.toHaveBeenCalled();
      expect(walletService.capture).not.toHaveBeenCalled();
      expect(accountLockService.releaseLock).not.toHaveBeenCalled();
    });

    it('REJECTS completion when fencingToken does not match the active fencingToken', async () => {
      await expect(
        workersService.completeJob('job-fencing-1', 'w-active-1', {
          officialReference: 'OFFICIAL-PASS-999',
          leaseGeneration: 3,
          fencingToken: 'fnc_mismatched_token', // MISMATCH!
        }),
      ).rejects.toThrow(ConflictException);

      expect(stateMachine.transition).not.toHaveBeenCalled();
    });

    it('REJECTS completion if a different machine claims completion', async () => {
      await expect(
        workersService.completeJob('job-fencing-1', 'w-impostor-9', {
          officialReference: 'OFFICIAL-PASS-999',
          leaseGeneration: 3,
          fencingToken: 'fnc_job-fencing-1_gen3_w-active',
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(stateMachine.transition).not.toHaveBeenCalled();
    });

    it('ACCEPTS completion with valid leaseGeneration and fencingToken, invoking state machine and capturing wallet', async () => {
      const result = await workersService.completeJob('job-fencing-1', 'w-active-1', {
        officialReference: 'OFFICIAL-PASS-999',
        leaseGeneration: 3,
        fencingToken: 'fnc_job-fencing-1_gen3_w-active',
      });

      expect(result.success).toBe(true);
      // Validated state machine transition invoked
      expect(stateMachine.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: 'br-fencing-1',
          targetStatus: BookingStatus.SUCCESS,
          officialReference: 'OFFICIAL-PASS-999',
          workerId: 'w-active-1',
          leaseGeneration: 3,
        }),
      );
      // Wallet capture invoked
      expect(walletService.capture).toHaveBeenCalled();
      // Account lock released with generation guard
      expect(accountLockService.releaseLock).toHaveBeenCalledWith('acc-1', 'br-fencing-1', 3);
    });
  });

  describe('2. Lease Generation Guard in failJob', () => {
    it('REJECTS failure report from a stale worker whose leaseGeneration is older than current', async () => {
      await expect(
        workersService.failJob('job-fencing-1', 'w-active-1', {
          status: BookingStatus.FAILED,
          errorMessage: 'Stale error',
          leaseGeneration: 1, // STALE!
        }),
      ).rejects.toThrow(ConflictException);

      expect(stateMachine.transition).not.toHaveBeenCalled();
      expect(accountLockService.releaseLock).not.toHaveBeenCalled();
    });

    it('ACCEPTS failure report with valid leaseGeneration and transitions through state machine', async () => {
      const result = await workersService.failJob('job-fencing-1', 'w-active-1', {
        status: BookingStatus.FAILED,
        errorMessage: 'Actual error',
        leaseGeneration: 3,
      });

      expect(result.success).toBe(true);
      expect(stateMachine.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: 'br-fencing-1',
          targetStatus: BookingStatus.FAILED,
          workerId: 'w-active-1',
          leaseGeneration: 3,
        }),
      );
      expect(accountLockService.releaseLock).toHaveBeenCalledWith('acc-1', 'br-fencing-1', 3);
    });
  });

  describe('3. AccountLockService Generation Guard', () => {
    it('ensures releaseLock uses generation-bounded filtering to prevent ABA race condition', async () => {
      const mockPrisma = {
        accountLock: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };

      const lockService = new AccountLockService(mockPrisma as any);
      await lockService.releaseLock('acc-test', 'br-test', 4);

      expect(mockPrisma.accountLock.deleteMany).toHaveBeenCalledWith({
        where: {
          accountId: 'acc-test',
          bookingId: 'br-test',
          leaseGeneration: 4,
        },
      });
    });
  });
});
