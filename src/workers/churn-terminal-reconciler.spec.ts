import { Test, TestingModule } from '@nestjs/testing';
import { WorkersService } from './workers.service';
import { SmartAllocatorService } from './smart-allocator.service';
import { BookingStateMachineService } from '../bookings/booking-state-machine.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccountLockService } from '../availability/account-lock.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { EventsGateway } from '../events/events.gateway';
import { BookingStatus, JobType, WorkerStatus } from '@prisma/client';

describe('Issue 1 (Full-Date Claim Churn), Issue 2 (Terminal Booking Job Closure), & Issue 3 (Reconciler Enum & Step Isolation)', () => {
  // =========================================================================
  // ISSUE 1: Full-date claim churn prevention & clean one-step WATCHING release
  // =========================================================================
  describe('Issue 1: WATCHING full-date claim guard & one-step failJob release', () => {
    let workersService: WorkersService;
    let mockPrisma: any;
    let mockAccountLockService: any;
    let mockSmartAllocator: any;
    let mockStateMachine: any;
    let mockJobs: any[];
    let mockBookings: any[];
    let mockDiscoverySchedules: any[];
    let mockOpportunities: any[];

    beforeEach(async () => {
      mockJobs = [];
      mockBookings = [];
      mockDiscoverySchedules = [];
      mockOpportunities = [];

      mockAccountLockService = {
        acquireLock: jest.fn().mockResolvedValue({ acquired: true }),
        releaseLock: jest.fn().mockResolvedValue(undefined),
        cleanupExpiredLocks: jest.fn().mockResolvedValue(0),
      };

      mockSmartAllocator = {
        releaseJobCapacity: jest.fn().mockResolvedValue(undefined),
        allocateNextPendingJob: jest.fn().mockResolvedValue(null),
      };

      mockStateMachine = {
        canTransition: jest.fn().mockImplementation((from: BookingStatus, to: BookingStatus) => {
          if (
            from === BookingStatus.CANCELLED ||
            from === BookingStatus.COMPLETED ||
            from === BookingStatus.FAILED ||
            from === BookingStatus.EXPIRED ||
            from === BookingStatus.SUCCESS
          ) {
            return false;
          }
          return true;
        }),
        transition: jest.fn().mockImplementation(async (req: any, tx?: any) => {
          const b = mockBookings.find((x) => x.id === req.bookingId);
          if (b) {
            b.status = req.targetStatus;
            if (req.targetStatus === BookingStatus.WATCHING) b.isWatching = true;
            if (req.assignedMachineId !== undefined) b.assignedMachineId = req.assignedMachineId;
            if (req.leaseExpiresAt !== undefined) b.leaseExpiresAt = req.leaseExpiresAt;
          }
          return { success: true, booking: b, newStatus: req.targetStatus };
        }),
      };

      const workerMachine = {
        id: 'worker-pc1',
        machineCode: 'PC-001',
        active: true,
        adminStatus: 'ENABLED',
        desiredState: 'RUNNING',
        maxConcurrentJobs: 3,
        currentActiveJobs: 0,
        status: WorkerStatus.ONLINE,
        lastHeartbeat: new Date(),
      };

      mockPrisma = {
        workerMachine: {
          findUnique: jest.fn().mockResolvedValue(workerMachine),
          update: jest.fn().mockResolvedValue(workerMachine),
        },
        bookingRequest: {
          findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
            const b = mockBookings.find((x) => x.id === where.id);
            return b ? { ...b } : null;
          }),
          update: jest.fn().mockImplementation(async ({ where, data }: any) => {
            const b = mockBookings.find((x) => x.id === where.id);
            if (b) Object.assign(b, data);
            return b || {};
          }),
        },
        bookingJob: {
          findMany: jest.fn().mockImplementation(async ({ where }: any) => {
            return mockJobs
              .filter((j) => {
                if (where?.workerId && j.workerId !== where.workerId) return false;
                if (where?.status?.notIn && where.status.notIn.includes(j.status)) return false;
                return true;
              })
              .map((j) => ({
                ...j,
                bookingRequest: mockBookings.find((b) => b.id === j.bookingRequestId) || null,
              }));
          }),
          findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
            const found = mockJobs.find((j) => {
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
              bookingRequest: mockBookings.find((b) => b.id === found.bookingRequestId) || null,
            };
          }),
          findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
            const found = mockJobs.find((j) => j.id === where.id);
            if (!found) return null;
            return {
              ...found,
              bookingRequest: mockBookings.find((b) => b.id === found.bookingRequestId) || null,
            };
          }),
          update: jest.fn().mockImplementation(async ({ where, data }: any) => {
            const j = mockJobs.find((x) => x.id === where.id);
            if (j) Object.assign(j, data);
            return j || {};
          }),
          updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
            const j = mockJobs.find((x) => x.id === where.id);
            if (!j) return { count: 0 };
            const nextGen = data.leaseGeneration?.increment
              ? (j.leaseGeneration ?? 0) + data.leaseGeneration.increment
              : data.leaseGeneration ?? j.leaseGeneration;
            Object.assign(j, { ...data, leaseGeneration: nextGen });
            return { count: 1 };
          }),
        },
        discoverySchedule: {
          findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
            return (
              mockDiscoverySchedules.find((s) => {
                if (where?.demandKey && s.demandKey !== where.demandKey) return false;
                return true;
              }) || null
            );
          }),
          updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
            let count = 0;
            for (const s of mockDiscoverySchedules) {
              if (!where?.demandKey || s.demandKey === where.demandKey) {
                Object.assign(s, data);
                count++;
              }
            }
            return { count };
          }),
        },
        availabilityOpportunity: {
          findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
            return (
              mockOpportunities.find((o) => {
                if (where?.date && o.date !== where.date) return false;
                if (where?.status && o.status !== where.status) return false;
                return true;
              }) || null
            );
          }),
        },
        bookingAttempt: { create: jest.fn().mockResolvedValue({}) },
        workerActivityLog: { create: jest.fn().mockResolvedValue({}) },
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          WorkersService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: WalletService, useValue: { capture: jest.fn(), release: jest.fn() } },
          { provide: AuditService, useValue: { log: jest.fn() } },
          { provide: NotificationsService, useValue: { send: jest.fn().mockResolvedValue({}) } },
          { provide: AccountLockService, useValue: mockAccountLockService },
          { provide: SmartMatcherService, useValue: { returnToPendingOnSlotLoss: jest.fn() } },
          { provide: BookingStateMachineService, useValue: mockStateMachine },
          { provide: SmartAllocatorService, useValue: mockSmartAllocator },
          { provide: EventsGateway, useValue: { emitBookingUpdate: jest.fn(), emitJobUpdate: jest.fn() } },
        ],
      }).compile();

      workersService = module.get<WorkersService>(WorkersService);
    });

    it('FULL date: queue poll skips WATCHING job without taking account lock or bumping leaseGeneration', async () => {
      mockBookings.push({
        id: 'br-full-1',
        bookingCode: 'TA-10052',
        status: BookingStatus.WATCHING,
        isWatching: true,
        requestedDateStr: '2026-11-26',
        requestedDate: new Date('2026-11-26'),
        route: 'Pamba (Regular Footpath Route)',
        pilgrimCount: 1,
        pilgrims: [{ fullName: 'Devotee', age: 30, gender: 'MALE' }],
        nomineeName: 'Nominee',
        nomineeAge: 35,
        nomineeRelationship: 'BROTHER',
        nomineePhone: '9876543210',
        accountId: 'acc-1',
        account: { id: 'acc-1', username: 'user1', encryptedPassword: 'x', encryptionIv: 'y', encryptionTag: 'z' },
      });

      mockJobs.push({
        id: 'job-full-1',
        jobType: JobType.BOOKING_EXECUTION,
        bookingRequestId: 'br-full-1',
        accountId: 'acc-1',
        workerId: null,
        status: BookingStatus.WATCHING,
        leaseGeneration: 4,
        leaseExpiresAt: null,
      });

      mockDiscoverySchedules.push({
        demandKey: '2026-11-26:PAMBA',
        status: 'UNAVAILABLE',
      });

      const res: any = await workersService.claimJob('worker-pc1', [], { triggerSource: 'QUEUE_POLL' });

      expect(res.hasJob).toBe(false);
      // No account lock acquired and no leaseGeneration increment
      expect(mockAccountLockService.acquireLock).not.toHaveBeenCalled();
      expect(mockJobs[0].leaseGeneration).toBe(4);
      expect(mockJobs[0].status).toBe(BookingStatus.WATCHING);
      expect(mockBookings[0].status).toBe(BookingStatus.WATCHING);
    });

    it('Date opens: WATCHING job IS claimed immediately when DiscoverySchedule is AVAILABLE or triggerSource is SLOT_OPENED', async () => {
      mockBookings.push({
        id: 'br-open-1',
        bookingCode: 'TA-10055',
        status: BookingStatus.WATCHING,
        isWatching: true,
        requestedDateStr: '2026-11-22',
        requestedDate: new Date('2026-11-22'),
        route: 'Pamba (Regular Footpath Route)',
        pilgrimCount: 1,
        pilgrims: [{ fullName: 'Devotee', age: 30, gender: 'MALE' }],
        nomineeName: 'Nominee',
        nomineeAge: 35,
        nomineeRelationship: 'BROTHER',
        nomineePhone: '9876543210',
        accountId: 'acc-1',
        account: { id: 'acc-1', username: 'user1', encryptedPassword: 'x', encryptionIv: 'y', encryptionTag: 'z' },
      });

      mockJobs.push({
        id: 'job-open-1',
        jobType: JobType.BOOKING_EXECUTION,
        bookingRequestId: 'br-open-1',
        accountId: 'acc-1',
        workerId: null,
        status: BookingStatus.WATCHING,
        leaseGeneration: 2,
        leaseExpiresAt: null,
      });

      // Even if cache hasn't flipped yet, SLOT_OPENED trigger claims immediately
      mockDiscoverySchedules.push({
        demandKey: '2026-11-22:PAMBA',
        status: 'UNAVAILABLE',
      });

      const res: any = await workersService.claimJob('worker-pc1', [], {
        triggerSource: 'SLOT_OPENED',
        date: '2026-11-22',
        route: 'Pamba (Regular Footpath Route)',
      });

      expect(res.hasJob).toBe(true);
      expect(res.job.id).toBe('job-open-1');
      expect(mockAccountLockService.acquireLock).toHaveBeenCalledTimes(1);
      expect(mockJobs[0].status).toBe(BookingStatus.EXECUTING);
      expect(mockJobs[0].leaseGeneration).toBe(3);
      expect(mockBookings[0].status).toBe(BookingStatus.EXECUTING);
    });

    it('failJob with DATE_UNAVAILABLE releases cleanly to WATCHING in ONE step without bumping leaseGeneration', async () => {
      mockBookings.push({
        id: 'br-fail-full',
        bookingCode: 'TA-10060',
        status: BookingStatus.EXECUTING,
        isWatching: false,
        requestedDateStr: '2026-11-26',
        requestedDate: new Date('2026-11-26'),
        route: 'Pamba (Regular Footpath Route)',
        accountId: 'acc-1',
      });

      mockJobs.push({
        id: 'job-fail-full',
        jobType: JobType.BOOKING_EXECUTION,
        bookingRequestId: 'br-fail-full',
        accountId: 'acc-1',
        workerId: 'worker-pc1',
        status: BookingStatus.EXECUTING,
        leaseGeneration: 7,
        fencingToken: 'tok-7',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });

      mockDiscoverySchedules.push({
        demandKey: '2026-11-26:PAMBA',
        status: 'AVAILABLE',
      });

      const res = await workersService.failJob('job-fail-full', 'worker-pc1', {
        status: BookingStatus.DATE_UNAVAILABLE,
        errorCode: 'DATE_UNAVAILABLE',
        errorMessage: 'Date is FULL/DISABLED on Sabarimala calendar',
        leaseGeneration: 7,
        fencingToken: 'tok-7',
      });

      expect(res.success).toBe(true);
      // Job released cleanly without bumping leaseGeneration
      expect(mockJobs[0].status).toBe(BookingStatus.WATCHING);
      expect(mockJobs[0].workerId).toBeNull();
      expect(mockJobs[0].leaseExpiresAt).toBeNull();
      expect(mockJobs[0].leaseGeneration).toBe(7);
      // Booking transitioned to WATCHING in ONE step
      expect(mockStateMachine.transition).toHaveBeenCalledTimes(1);
      expect(mockBookings[0].status).toBe(BookingStatus.WATCHING);
      // Discovery cache updated to UNAVAILABLE
      expect(mockDiscoverySchedules[0].status).toBe('UNAVAILABLE');
      // Capacity released with triggerReallocation = false (no churn loop)
      expect(mockSmartAllocator.releaseJobCapacity).toHaveBeenCalledWith('worker-pc1', 'job-fail-full', 'br-fail-full', false);
    });
  });

  // =========================================================================
  // ISSUE 2: Terminal bookings close their jobs & allocator skips terminal jobs
  // =========================================================================
  describe('Issue 2: Terminal booking closure & allocator terminal guard', () => {
    it('BookingStateMachineService.transition(CANCELLED) closes open jobs and releases account locks in the SAME transaction', async () => {
      const booking = {
        id: 'br-cancel-1',
        bookingCode: 'TA-10070',
        status: BookingStatus.EXECUTION_QUEUED,
        version: 2,
        executionStatus: 'QUEUED',
        financialStatus: 'RESERVED',
      };

      const txMock: any = {
        bookingRequest: {
          findUnique: jest.fn().mockResolvedValue(booking),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue({ ...booking, status: BookingStatus.CANCELLED, version: 3 }),
        },
        bookingJob: {
          updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
        accountLock: {
          deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        bookingMilestone: {
          create: jest.fn().mockResolvedValue({}),
        },
      };

      const prismaMock: any = {
        $transaction: jest.fn(async (cb) => cb(txMock)),
      };

      const stateMachine = new BookingStateMachineService(prismaMock);

      const res = await stateMachine.transition({
        bookingId: 'br-cancel-1',
        targetStatus: BookingStatus.CANCELLED,
        milestone: 'USER_CANCELLED',
        operator: 'User:u1',
      });

      expect(res.success).toBe(true);
      expect(res.newStatus).toBe(BookingStatus.CANCELLED);
      // Closed all non-terminal jobs in the SAME transaction
      expect(txMock.bookingJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            bookingRequestId: 'br-cancel-1',
          }),
          data: expect.objectContaining({
            status: BookingStatus.CANCELLED,
            workerId: null,
            leaseExpiresAt: null,
          }),
        }),
      );
      // Released any account lock in the SAME transaction
      expect(txMock.accountLock.deleteMany).toHaveBeenCalledWith({
        where: { bookingId: 'br-cancel-1' },
      });
    });

    it('SmartAllocatorService.allocateJob closes orphaned job for CANCELLED booking BEFORE acquiring account lock or transitioning', async () => {
      const mockAccountLock = {
        acquireLock: jest.fn().mockResolvedValue({ acquired: true }),
        releaseLock: jest.fn().mockResolvedValue(undefined),
        cleanupExpiredLocks: jest.fn().mockResolvedValue(0),
      };

      const mockStateMachine = {
        canTransition: jest.fn().mockReturnValue(false),
        transition: jest.fn().mockRejectedValue(new Error('Invalid state transition CANCELLED -> EXECUTING')),
      };

      const mockPrisma: any = {
        bookingJob: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'job-orphan-cancel',
            jobType: JobType.BOOKING_EXECUTION,
            status: BookingStatus.QUEUED,
            bookingRequestId: 'br-cancelled-99',
            accountId: 'acc-1',
            bookingRequest: {
              id: 'br-cancelled-99',
              bookingCode: 'TA-GRAB-8619521',
              status: BookingStatus.CANCELLED,
              accountId: 'acc-1',
              requestedDateStr: '2026-11-26',
              route: 'Pamba',
            },
          }),
          update: jest.fn().mockResolvedValue({}),
        },
        workerMachine: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SmartAllocatorService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: AccountLockService, useValue: mockAccountLock },
          { provide: BookingStateMachineService, useValue: mockStateMachine },
          { provide: WalletService, useValue: { capture: jest.fn() } },
        ],
      }).compile();

      const allocator = module.get<SmartAllocatorService>(SmartAllocatorService);
      const decision = await allocator.allocateJob('job-orphan-cancel');

      expect(decision.allocated).toBe(false);
      // Closed orphaned job directly as CANCELLED
      expect(mockPrisma.bookingJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-orphan-cancel' },
          data: expect.objectContaining({
            status: BookingStatus.CANCELLED,
            workerId: null,
            leaseExpiresAt: null,
          }),
        }),
      );
      // NEVER acquired account lock and NEVER triggered CANCELLED -> EXECUTING
      expect(mockAccountLock.acquireLock).not.toHaveBeenCalled();
      expect(mockStateMachine.transition).not.toHaveBeenCalled();
    });

    it('SmartAllocatorService.runAllocationSweep excludes jobs whose BookingRequest is terminal', async () => {
      const mockPrisma: any = {
        bookingJob: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SmartAllocatorService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: AccountLockService, useValue: { acquireLock: jest.fn(), releaseLock: jest.fn(), cleanupExpiredLocks: jest.fn() } },
          { provide: BookingStateMachineService, useValue: { canTransition: jest.fn(), transition: jest.fn() } },
          { provide: WalletService, useValue: { capture: jest.fn() } },
        ],
      }).compile();

      const allocator = module.get<SmartAllocatorService>(SmartAllocatorService);
      await allocator.runAllocationSweep();

      expect(mockPrisma.bookingJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                bookingRequest: expect.objectContaining({
                  status: expect.objectContaining({
                    notIn: expect.arrayContaining([
                      BookingStatus.CANCELLED,
                      BookingStatus.COMPLETED,
                      BookingStatus.FAILED,
                      BookingStatus.EXPIRED,
                      BookingStatus.WATCHING,
                    ]),
                  }),
                }),
              }),
            ]),
          }),
        }),
      );
    });
  });

  // =========================================================================
  // ISSUE 3: Reconciler valid BookingStatus enum, step isolation, & pass auto-completion
  // =========================================================================
  describe('Issue 3: Reconciler valid enum query, step isolation, & confirmed pass completion', () => {
    const validBookingStatuses = new Set(Object.values(BookingStatus));

    it('uses only valid Prisma BookingStatus enum values and auto-completes a confirmed pass stuck after completeJob 500', async () => {
      const confirmedBooking = {
        id: 'br-pass-500',
        bookingCode: 'TA-10051',
        userId: 'user-1',
        status: BookingStatus.EXECUTING,
        officialBookingReference: 'IVQ26112019410571880889',
        officialReference: 'IVQ26112019410571880889',
        cartId: '1928697091',
        jobs: [{ id: 'job-pass-500', status: BookingStatus.EXECUTING }],
      };

      const mockWallet = {
        capture: jest.fn().mockResolvedValue({ success: true }),
      };

      const mockStateMachine = {
        canTransition: jest.fn().mockReturnValue(true),
        transition: jest.fn().mockResolvedValue({ success: true }),
      };

      const findManyCalls: any[] = [];

      const mockPrisma: any = {
        bookingJob: {
          findMany: jest.fn().mockImplementation(async (args: any) => {
            findManyCalls.push(args);
            // Enforce Prisma enum validation: fail loudly if an invalid enum value like 'NEEDS_REVIEW' is passed as job status!
            const checkStatusValues = (obj: any) => {
              if (!obj || typeof obj !== 'object') return;
              if (typeof obj.status === 'string' && !validBookingStatuses.has(obj.status as BookingStatus)) {
                throw new Error(`Invalid value for argument status: ${obj.status}. Expected BookingStatus.`);
              }
              if (Array.isArray(obj.status?.in)) {
                for (const s of obj.status.in) {
                  if (!validBookingStatuses.has(s)) {
                    throw new Error(`Invalid value for argument status.in: ${s}. Expected BookingStatus.`);
                  }
                }
              }
              if (Array.isArray(obj.OR)) {
                for (const clause of obj.OR) {
                  if (clause.status) checkStatusValues(clause);
                }
              }
            };
            checkStatusValues(args?.where);
            return [];
          }),
          update: jest.fn().mockResolvedValue({}),
          updateMany: jest.fn().mockResolvedValue({ count: 3 }),
        },
        bookingRequest: {
          findMany: jest.fn().mockImplementation(async ({ where }: any) => {
            if (where?.officialBookingReference?.not === null) {
              return [confirmedBooking];
            }
            return [];
          }),
          update: jest.fn().mockResolvedValue({}),
        },
        walletTransaction: {
          findFirst: jest.fn().mockResolvedValue({ id: 'wtx-1', amount: 10, type: 'RESERVE', status: 'COMPLETED' }),
        },
        bookingReconciliation: {
          upsert: jest.fn().mockResolvedValue({}),
        },
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SmartAllocatorService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: AccountLockService, useValue: { acquireLock: jest.fn(), releaseLock: jest.fn(), cleanupExpiredLocks: jest.fn().mockResolvedValue(0) } },
          { provide: BookingStateMachineService, useValue: mockStateMachine },
          { provide: WalletService, useValue: mockWallet },
        ],
      }).compile();

      const allocator = module.get<SmartAllocatorService>(SmartAllocatorService);
      const res: any = await allocator.recoverStaleLeases();

      // 1. Confirmed pass with failed completeJob was detected and completed
      expect(res.uncompletedPassesReconciled).toBe(1);
      expect(mockPrisma.bookingJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-pass-500' },
          data: expect.objectContaining({ status: BookingStatus.SUCCESS }),
        }),
      );
      expect(mockStateMachine.transition).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: 'br-pass-500',
          targetStatus: BookingStatus.SUCCESS,
          officialBookingReference: 'IVQ26112019410571880889',
        }),
        expect.anything(),
      );
      expect(mockWallet.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          bookingId: 'br-pass-500',
          amount: 10,
          idempotencyKey: 'cap_br-pass-500',
        }),
        expect.anything(),
      );

      // 2. Step 7b queried valid BookingStatus.RECONCILIATION_REQUIRED (never invalid 'NEEDS_REVIEW' as status)
      const needsReviewQuery = findManyCalls.find((c) => Array.isArray(c?.where?.OR));
      expect(needsReviewQuery).toBeDefined();
      expect(needsReviewQuery.where.OR).toEqual(
        expect.arrayContaining([
          { status: BookingStatus.RECONCILIATION_REQUIRED },
          { bookingRequest: { reconciliationStatus: 'NEEDS_REVIEW' } },
        ]),
      );

      // 3. Step 7c closed orphaned terminal jobs
      expect(res.orphanedTerminalJobsClosed).toBe(3);
    });

    it('isolates step failures: if Step 1 and Step 7a fail, Step 7c still runs and uncompletedPassesReconciled is omitted', async () => {
      let jobFindManyCall = 0;

      const mockPrisma: any = {
        bookingJob: {
          findMany: jest.fn().mockImplementation(async () => {
            jobFindManyCall++;
            if (jobFindManyCall === 1) {
              throw new Error('Simulated Step 1 DB timeout');
            }
            return [];
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
        bookingRequest: {
          findMany: jest.fn().mockImplementation(async ({ where }: any) => {
            if (where?.officialBookingReference?.not === null) {
              throw new Error('Simulated Step 7a query failure');
            }
            return [];
          }),
        },
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SmartAllocatorService,
          { provide: PrismaService, useValue: mockPrisma },
          { provide: AccountLockService, useValue: { acquireLock: jest.fn(), releaseLock: jest.fn(), cleanupExpiredLocks: jest.fn().mockResolvedValue(1) } },
          { provide: BookingStateMachineService, useValue: { canTransition: jest.fn(), transition: jest.fn() } },
          { provide: WalletService, useValue: { capture: jest.fn() } },
        ],
      }).compile();

      const allocator = module.get<SmartAllocatorService>(SmartAllocatorService);
      const res: any = await allocator.recoverStaleLeases();

      // Step 7a failed -> must NOT falsely report uncompletedPassesReconciled: 0
      expect(res.uncompletedPassesReconciled).toBeUndefined();
      // Subsequent isolated steps STILL ran
      expect(res.expiredLocksCleaned).toBe(1);
      expect(res.orphanedTerminalJobsClosed).toBe(2);
    });
  });
});
