import { Test, TestingModule } from '@nestjs/testing';
import { SmartAllocatorService } from './smart-allocator.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccountLockService } from '../availability/account-lock.service';
import { EventsGateway } from '../events/events.gateway';
import { WorkerStatus, BookingStatus, JobType } from '@prisma/client';

describe('SmartAllocatorService — Worker Availability & Automatic Allocation', () => {
  let service: SmartAllocatorService;
  let prisma: PrismaService;
  let accountLockService: AccountLockService;

  // In-memory mock store
  let mockWorkers: any[] = [];
  let mockJobs: any[] = [];
  let mockBookingRequests: any[] = [];
  let mockAllocationLogs: any[] = [];
  let mockActivityLogs: any[] = [];

  beforeEach(async () => {
    mockWorkers = [
      {
        id: 'worker-local-1',
        machineCode: 'PC-LOCAL-001',
        machineName: 'Windows Desktop 1',
        deploymentType: 'LOCAL_PC',
        active: true,
        adminStatus: 'ENABLED',
        desiredState: 'RUNNING',
        status: WorkerStatus.ONLINE,
        machineToken: 'tok-1',
        maxConcurrentJobs: 2,
        currentActiveJobs: 0,
        capabilities: ['ACCOUNT_VERIFICATION', 'BOOKING_EXECUTION'],
        lastHeartbeat: new Date(),
        cpuUsage: 15,
        memoryUsage: 25,
        lastJobAt: null,
      },
      {
        id: 'worker-vm-2',
        machineCode: 'VM-CLOUD-002',
        machineName: 'Azure Cloud VM',
        deploymentType: 'CLOUD_VM',
        active: true,
        adminStatus: 'ENABLED',
        desiredState: 'RUNNING',
        status: WorkerStatus.ONLINE,
        machineToken: 'tok-2',
        maxConcurrentJobs: 4,
        currentActiveJobs: 1,
        capabilities: ['BOOKING_EXECUTION'],
        lastHeartbeat: new Date(),
        cpuUsage: 30,
        memoryUsage: 45,
        lastJobAt: new Date(Date.now() - 3600000),
      },
    ];

    mockBookingRequests = [
      {
        id: 'br-101',
        bookingCode: 'BK-101',
        status: BookingStatus.QUEUED,
        officialReference: null,
      },
    ];

    mockJobs = [
      {
        id: 'job-exec-1',
        bookingRequestId: 'br-101',
        bookingRequest: mockBookingRequests[0],
        account: null,
        jobType: JobType.BOOKING_EXECUTION,
        status: BookingStatus.QUEUED,
        workerId: null,
        attempt: 0,
        maxAttempts: 3,
        leaseExpiresAt: null,
        createdAt: new Date(),
      },
    ];

    mockAllocationLogs = [];
    mockActivityLogs = [];

    const mockPrismaService = {
      workerMachine: {
        findMany: jest.fn().mockImplementation(async (args?: any) => {
          let list = [...mockWorkers];
          if (args?.where?.active !== undefined) {
            list = list.filter((w) => w.active === args.where.active);
          }
          if (args?.where?.adminStatus !== undefined) {
            list = list.filter((w) => w.adminStatus === args.where.adminStatus);
          }
          if (args?.where?.desiredState !== undefined) {
            list = list.filter((w) => w.desiredState === args.where.desiredState);
          }
          return list;
        }),
        findUnique: jest.fn().mockImplementation(async (args: any) => {
          return mockWorkers.find((w) => w.id === args.where.id) || null;
        }),
        update: jest.fn().mockImplementation(async (args: any) => {
          const idx = mockWorkers.findIndex((w) => w.id === args.where.id);
          if (idx === -1) throw new Error('Worker not found');
          const target = mockWorkers[idx];

          if (args.data.currentActiveJobs?.increment) {
            target.currentActiveJobs = (target.currentActiveJobs || 0) + args.data.currentActiveJobs.increment;
          } else if (typeof args.data.currentActiveJobs === 'number') {
            target.currentActiveJobs = args.data.currentActiveJobs;
          }

          if (args.data.status) target.status = args.data.status;
          if (args.data.currentJobId !== undefined) target.currentJobId = args.data.currentJobId;
          if (args.data.lastJobAt) target.lastJobAt = args.data.lastJobAt;
          if (args.data.maxConcurrentJobs) target.maxConcurrentJobs = args.data.maxConcurrentJobs;
          if (args.data.deploymentType) target.deploymentType = args.data.deploymentType;

          return { ...target };
        }),
      },
      bookingJob: {
        findUnique: jest.fn().mockImplementation(async (args: any) => {
          return mockJobs.find((j) => j.id === args.where.id) || null;
        }),
        findFirst: jest.fn().mockImplementation(async (args: any) => {
          return mockJobs.find((j) => {
            if (args.where.jobType && j.jobType !== args.where.jobType) return false;
            if (args.where.status) {
              if (Array.isArray(args.where.status?.in)) {
                return args.where.status.in.includes(j.status);
              }
              return j.status === args.where.status;
            }
            return true;
          }) || null;
        }),
        findMany: jest.fn().mockImplementation(async (args?: any) => {
          let list = [...mockJobs];
          if (args?.where?.status?.in) {
            list = list.filter((j) => args.where.status.in.includes(j.status));
          }
          if (args?.where?.leaseExpiresAt?.lte) {
            list = list.filter((j) => j.leaseExpiresAt && j.leaseExpiresAt <= args.where.leaseExpiresAt.lte);
          }
          return list;
        }),
        updateMany: jest.fn().mockImplementation(async (args: any) => {
          let count = 0;
          for (const j of mockJobs) {
            if (j.id === args.where.id && j.status === args.where.status) {
              if (args.data.status) j.status = args.data.status;
              if (args.data.workerId !== undefined) j.workerId = args.data.workerId;
              if (args.data.leaseExpiresAt !== undefined) j.leaseExpiresAt = args.data.leaseExpiresAt;
              if (args.data.attempt?.increment) j.attempt = (j.attempt || 0) + args.data.attempt.increment;
              count++;
            }
          }
          return { count };
        }),
        update: jest.fn().mockImplementation(async (args: any) => {
          const idx = mockJobs.findIndex((j) => j.id === args.where.id);
          if (idx === -1) throw new Error('Job not found');
          const target = mockJobs[idx];
          Object.assign(target, args.data);
          return { ...target };
        }),
        count: jest.fn().mockImplementation(async (args: any) => {
          return mockJobs.filter((j) => j.workerId === args.where.workerId && args.where.status.in.includes(j.status)).length;
        }),
      },
      bookingRequest: {
        update: jest.fn().mockImplementation(async (args: any) => {
          const idx = mockBookingRequests.findIndex((b) => b.id === args.where.id);
          if (idx !== -1) {
            Object.assign(mockBookingRequests[idx], args.data);
            return { ...mockBookingRequests[idx] };
          }
          return null;
        }),
      },
      jobAllocationLog: {
        create: jest.fn().mockImplementation(async (args: any) => {
          const entry = { id: `log-${mockAllocationLogs.length + 1}`, ...args.data, createdAt: new Date() };
          mockAllocationLogs.push(entry);
          return entry;
        }),
        findMany: jest.fn().mockImplementation(async () => mockAllocationLogs),
        count: jest.fn().mockImplementation(async () => mockAllocationLogs.length),
      },
      workerActivityLog: {
        create: jest.fn().mockImplementation(async (args: any) => {
          const entry = { id: `act-${mockActivityLogs.length + 1}`, ...args.data, createdAt: new Date() };
          mockActivityLogs.push(entry);
          return entry;
        }),
      },
      $transaction: jest.fn().mockImplementation(async (cb: (tx: any) => Promise<any>) => {
        return cb(mockPrismaService);
      }),
    };

    const mockAccountLockService = {
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
    };

    const mockEventsGateway = {
      emitToAdmins: jest.fn(),
      notifyFleetUpdated: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmartAllocatorService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: AccountLockService, useValue: mockAccountLockService },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    service = module.get<SmartAllocatorService>(SmartAllocatorService);
    prisma = module.get<PrismaService>(PrismaService);
    accountLockService = module.get<AccountLockService>(AccountLockService);
  });

  describe('Authoritative Availability Evaluation', () => {
    it('1. correctly identifies an online and healthy worker with available capacity', () => {
      const assessment = service.evaluateWorkerAvailability(mockWorkers[0]);
      expect(assessment.isAvailable).toBe(true);
      expect(assessment.effectiveState).toBe('ONLINE_IDLE');
      expect(assessment.capacityRemaining).toBe(2);
      expect(assessment.exclusionReason).toBeNull();
    });

    it('2. excludes a stale worker whose heartbeat is older than 45 seconds', () => {
      const staleWorker = {
        ...mockWorkers[0],
        lastHeartbeat: new Date(Date.now() - 60000), // 60s ago
      };
      const assessment = service.evaluateWorkerAvailability(staleWorker);
      expect(assessment.isAvailable).toBe(false);
      expect(assessment.effectiveState).toBe('OFFLINE');
      expect(assessment.exclusionReason).toContain('stale');
    });

    it('3. excludes a worker whose adminStatus is REVOKED or DISABLED', () => {
      const revoked = { ...mockWorkers[0], adminStatus: 'REVOKED' };
      const disabled = { ...mockWorkers[0], adminStatus: 'DISABLED' };

      expect(service.evaluateWorkerAvailability(revoked).isAvailable).toBe(false);
      expect(service.evaluateWorkerAvailability(revoked).effectiveState).toBe('REVOKED');

      expect(service.evaluateWorkerAvailability(disabled).isAvailable).toBe(false);
      expect(service.evaluateWorkerAvailability(disabled).effectiveState).toBe('DISABLED');
    });

    it('4. excludes a worker whose desiredState is PAUSED or STOPPING (draining)', () => {
      const paused = { ...mockWorkers[0], desiredState: 'PAUSED' };
      const draining = { ...mockWorkers[0], desiredState: 'STOPPING' };

      const pausedEval = service.evaluateWorkerAvailability(paused);
      expect(pausedEval.isAvailable).toBe(false);
      expect(pausedEval.effectiveState).toBe('PAUSED');

      const drainingEval = service.evaluateWorkerAvailability(draining);
      expect(drainingEval.isAvailable).toBe(false);
      expect(drainingEval.effectiveState).toBe('DRAINING');
    });

    it('5. excludes a worker that has reached its maxConcurrentJobs capacity limit', () => {
      const fullWorker = {
        ...mockWorkers[0],
        maxConcurrentJobs: 2,
        currentActiveJobs: 2,
      };
      const assessment = service.evaluateWorkerAvailability(fullWorker);
      expect(assessment.isAvailable).toBe(false);
      expect(assessment.effectiveState).toBe('ONLINE_BUSY');
      expect(assessment.capacityRemaining).toBe(0);
      expect(assessment.exclusionReason).toContain('maximum concurrency limit');
    });

    it('6. excludes a worker in MONITOR_ONLY mode from booking execution jobs', () => {
      const monitorOnly = { ...mockWorkers[0], desiredState: 'MONITOR_ONLY' };
      const assessment = service.evaluateWorkerAvailability(monitorOnly);
      expect(assessment.isAvailable).toBe(false);
      expect(assessment.exclusionReason).toContain('MONITOR_ONLY');
    });
  });

  describe('Worker Selection Policy & Capabilities', () => {
    it('7. selects the least-loaded worker with deterministic tie-breaking', () => {
      // worker-local-1 has 0 active jobs (load 0), worker-vm-2 has 1 active job
      const res = service.selectBestWorker(mockWorkers, 'BOOKING_EXECUTION');
      expect(res.selected).toBeDefined();
      expect(res.selected.id).toBe('worker-local-1');
      expect(res.reason).toContain('Selected least-loaded worker');
    });

    it('8. excludes a worker that does not possess the required capability', () => {
      // worker-vm-2 only has ['BOOKING_EXECUTION'], not ['ACCOUNT_VERIFICATION']
      // worker-local-1 has both
      const workers = [
        { ...mockWorkers[1], currentActiveJobs: 0 }, // vm-2: 0 jobs, but lacks capability
      ];
      const res = service.selectBestWorker(workers, 'ACCOUNT_VERIFICATION');
      expect(res.selected).toBeNull();
      expect(res.reason).toContain('No eligible workers available');
    });
  });

  describe('Atomic Allocation & Capacity Reservations', () => {
    it('9. allocates one pending job to the best available worker and reserves capacity', async () => {
      const result = await service.allocateJob('job-exec-1');
      expect(result.allocated).toBe(true);
      expect(result.workerId).toBe('worker-local-1');

      // Job status updated to WORKER_ASSIGNED
      const updatedJob = mockJobs.find((j) => j.id === 'job-exec-1');
      expect(updatedJob.status).toBe(BookingStatus.WORKER_ASSIGNED);
      expect(updatedJob.workerId).toBe('worker-local-1');

      // Worker active jobs incremented
      const updatedWorker = mockWorkers.find((w) => w.id === 'worker-local-1');
      expect(updatedWorker.currentActiveJobs).toBe(1);
      expect(updatedWorker.status).toBe(WorkerStatus.BUSY);

      // Allocation log created
      expect(mockAllocationLogs.length).toBe(1);
      expect(mockAllocationLogs[0].status).toBe('ALLOCATED');
      expect(mockAllocationLogs[0].workerId).toBe('worker-local-1');
    });

    it('10. prevents duplicate assignment if the job is concurrently claimed or state changes', async () => {
      // Simulate job already claimed
      mockJobs[0].status = BookingStatus.WORKER_ASSIGNED;

      const result = await service.allocateJob('job-exec-1');
      expect(result.allocated).toBe(false);
      expect(result.decisionReason).toContain('not eligible for initial allocation');
    });

    it('11. leaves job in recoverable state if no workers are available', async () => {
      // Make all workers offline
      mockWorkers.forEach((w) => {
        w.lastHeartbeat = new Date(Date.now() - 100000);
      });

      const result = await service.allocateJob('job-exec-1');
      expect(result.allocated).toBe(false);
      expect(result.decisionReason).toContain('No eligible workers available');

      // Job status remains QUEUED
      expect(mockJobs[0].status).toBe(BookingStatus.QUEUED);
      expect(mockJobs[0].workerId).toBeNull();
    });
  });

  describe('Capacity Release & Safe Stale Lease Recovery', () => {
    it('12. releases capacity safely on completion and never drops below 0', async () => {
      mockWorkers[0].currentActiveJobs = 1;
      await service.releaseJobCapacity('worker-local-1', 'job-exec-1');

      expect(mockWorkers[0].currentActiveJobs).toBe(0);
      expect(mockWorkers[0].status).toBe(WorkerStatus.ONLINE);

      // Releasing again should stay at 0
      await service.releaseJobCapacity('worker-local-1', 'job-exec-1');
      expect(mockWorkers[0].currentActiveJobs).toBe(0);
    });

    it('13. safely recovers an expired lease back to QUEUED when outcome is unambiguous', async () => {
      mockJobs[0].status = BookingStatus.WORKER_ASSIGNED;
      mockJobs[0].workerId = 'worker-local-1';
      mockJobs[0].attempt = 1;
      mockJobs[0].leaseExpiresAt = new Date(Date.now() - 5000); // Expired 5s ago
      mockWorkers[0].currentActiveJobs = 1;

      const res = await service.recoverStaleLeases();
      expect(res.recoveredCount).toBe(1);
      expect(res.humanReviewCount).toBe(0);

      // Job reset to QUEUED
      expect(mockJobs[0].status).toBe(BookingStatus.QUEUED);
      expect(mockJobs[0].workerId).toBeNull();

      // Worker capacity released
      expect(mockWorkers[0].currentActiveJobs).toBe(0);
    });

    it('14. quarantines ambiguous execution jobs in REQUIRES_HUMAN to prevent duplicate bookings', async () => {
      mockJobs[0].status = BookingStatus.EXECUTING;
      mockJobs[0].workerId = 'worker-local-1';
      mockJobs[0].attempt = 2; // >1 attempt during active execution without confirmed portal reference
      mockJobs[0].leaseExpiresAt = new Date(Date.now() - 5000);
      mockWorkers[0].currentActiveJobs = 1;

      const res = await service.recoverStaleLeases();
      expect(res.recoveredCount).toBe(0);
      expect(res.humanReviewCount).toBe(1);

      // Job quarantined in REQUIRES_HUMAN
      expect(mockJobs[0].status).toBe(BookingStatus.REQUIRES_HUMAN);
      expect(mockBookingRequests[0].status).toBe(BookingStatus.REQUIRES_HUMAN);
    });

    it('15. allows administrators to update per-worker capacity and deployment type', async () => {
      const updated = await service.updateWorkerCapacity('worker-local-1', {
        maxConcurrentJobs: 5,
        deploymentType: 'DOCKER',
      });

      expect(updated.maxConcurrentJobs).toBe(5);
      expect(updated.deploymentType).toBe('DOCKER');
      expect(mockWorkers[0].maxConcurrentJobs).toBe(5);
      expect(mockWorkers[0].deploymentType).toBe('DOCKER');
    });
  });
});
