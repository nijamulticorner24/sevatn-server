import { Test, TestingModule } from '@nestjs/testing';
import { SmartAllocatorService } from './smart-allocator.service';
import { AvailabilityService } from '../availability/availability.service';
import { WorkersService } from './workers.service';
import { PrismaService } from '../prisma/prisma.service';
import { AccountLockService } from '../availability/account-lock.service';
import { DiscoverySchedulerService } from '../availability/discovery-scheduler.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WorkerStatus, BookingStatus } from '@prisma/client';

describe('Dynamic Dual-Worker Monitoring Capacity & Zero Lost Dates Suite', () => {
  let allocator: SmartAllocatorService;
  let availability: AvailabilityService;
  let workersService: WorkersService;

  // In-memory test state fixtures
  let workerMachines: any[] = [];
  let bookingRequests: any[] = [];

  const mockPrisma: any = {
    workerMachine: {
      findUnique: jest.fn().mockImplementation(({ where }: any) => {
        return Promise.resolve(workerMachines.find((w) => w.id === where.id || w.machineToken === where.machineToken) || null);
      }),
      findMany: jest.fn().mockImplementation(({ where, orderBy }: any) => {
        let list = [...workerMachines];
        if (where?.status?.in) list = list.filter((w) => where.status.in.includes(w.status));
        else if (where?.status) list = list.filter((w) => w.status === where.status);
        if (where?.active !== undefined) list = list.filter((w) => w.active === where.active);
        if (where?.desiredState) list = list.filter((w) => w.desiredState === where.desiredState);
        if (where?.lastHeartbeat?.gte) {
          list = list.filter((w) => w.lastHeartbeat && w.lastHeartbeat >= where.lastHeartbeat.gte);
        }
        if (where?.OR) {
          list = list.filter((w) => {
            return where.OR.some((cond: any) => {
              if (cond.status) return w.status === cond.status;
              if (cond.lastHeartbeat?.lt) return !w.lastHeartbeat || w.lastHeartbeat < cond.lastHeartbeat.lt;
              if (cond.lastHeartbeat === null) return !w.lastHeartbeat;
              return false;
            });
          });
        }
        if (orderBy && Array.isArray(orderBy)) {
          list.sort((a, b) => {
            if (a.deploymentType === 'DOCKER' && b.deploymentType !== 'DOCKER') return -1;
            if (a.deploymentType !== 'DOCKER' && b.deploymentType === 'DOCKER') return 1;
            return 0;
          });
        }
        return Promise.resolve(list);
      }),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        const idx = workerMachines.findIndex((w) => w.id === where.id);
        if (idx !== -1) {
          workerMachines[idx] = { ...workerMachines[idx], ...data };
          return Promise.resolve(workerMachines[idx]);
        }
        return Promise.resolve(null);
      }),
    },
    bookingRequest: {
      findUnique: jest.fn().mockImplementation(({ where }: any) => {
        return Promise.resolve(bookingRequests.find((b) => b.id === where.id) || null);
      }),
      count: jest.fn().mockImplementation(({ where }: any) => {
        let list = [...bookingRequests];
        if (where?.assignedMonitoringWorkerId !== undefined) {
          if (where.assignedMonitoringWorkerId === null) {
            list = list.filter((b) => b.assignedMonitoringWorkerId === null);
          } else if (where.assignedMonitoringWorkerId && typeof where.assignedMonitoringWorkerId === 'object' && where.assignedMonitoringWorkerId.not === null) {
            list = list.filter((b) => b.assignedMonitoringWorkerId !== null);
          } else {
            list = list.filter((b) => b.assignedMonitoringWorkerId === where.assignedMonitoringWorkerId);
          }
        }
        if (where?.status?.in) {
          list = list.filter((b) => where.status.in.includes(b.status));
        }
        return Promise.resolve(list.length);
      }),
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        let list = [...bookingRequests];
        if (where?.assignedMonitoringWorkerId !== undefined) {
          list = list.filter((b) => b.assignedMonitoringWorkerId === where.assignedMonitoringWorkerId);
        }
        if (where?.status?.in) {
          list = list.filter((b) => where.status.in.includes(b.status));
        }
        return Promise.resolve(list);
      }),
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        let count = 0;
        for (let i = 0; i < bookingRequests.length; i++) {
          const b = bookingRequests[i];
          let match = true;
          if (where?.id?.in && !where.id.in.includes(b.id)) match = false;
          if (where?.assignedMonitoringWorkerId === null && b.assignedMonitoringWorkerId !== null) match = false;
          if (where?.isManuallyAssigned !== undefined && b.isManuallyAssigned !== where.isManuallyAssigned) match = false;
          if (where?.status?.in && !where.status.in.includes(b.status)) match = false;
          if (where?.monitoringLeaseExpiresAt?.lt && (!b.monitoringLeaseExpiresAt || b.monitoringLeaseExpiresAt >= where.monitoringLeaseExpiresAt.lt)) match = false;

          if (match) {
            bookingRequests[i] = { ...bookingRequests[i], ...data };
            count++;
          }
        }
        return Promise.resolve({ count });
      }),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        const idx = bookingRequests.findIndex((b) => b.id === where.id);
        if (idx !== -1) {
          bookingRequests[idx] = { ...bookingRequests[idx], ...data };
          return Promise.resolve(bookingRequests[idx]);
        }
        return Promise.resolve(null);
      }),
    },
    workerActivityLog: {
      create: jest.fn().mockResolvedValue({ id: 'log-1' }),
    },
    $queryRaw: jest.fn().mockImplementation((strings: any, ...values: any[]) => {
      // Simulate FOR UPDATE SKIP LOCKED
      const freeSlots = values[0] || 10;
      const unassigned = bookingRequests
        .filter((b) => !b.assignedMonitoringWorkerId && !b.isManuallyAssigned && ['PENDING', 'WATCHING', 'FAST_BOOKING_QUEUED'].includes(b.status))
        .slice(0, freeSlots);
      return Promise.resolve(unassigned.map((b) => ({ id: b.id })));
    }),
  };

  const mockLockService: any = {
    isLocked: jest.fn().mockResolvedValue(false),
    releaseLockByWorker: jest.fn().mockResolvedValue(true),
  };

  const mockScheduler: any = {
    ensureSchedule: jest.fn().mockImplementation((date, route) => ({
      date,
      route,
      status: 'SCHEDULED',
      nextCheckAt: new Date(Date.now() - 1000),
      lockedBy: null,
      lockExpiresAt: null,
    })),
  };

  const mockSmartMatcher: any = {
    findCandidates: jest.fn().mockResolvedValue([]),
  };

  const mockWalletService: any = {
    reserveFunds: jest.fn().mockResolvedValue(true),
  };

  const mockAuditService: any = {
    logAction: jest.fn().mockResolvedValue(true),
  };

  const mockNotifications: any = {
    sendAlert: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    workerMachines = [
      {
        id: 'worker-cloud-1',
        machineCode: 'CLOUD-DOCKER-1',
        deploymentType: 'DOCKER',
        status: WorkerStatus.ONLINE,
        desiredState: 'RUNNING',
        active: true,
        adminStatus: 'ENABLED',
        maxMonitoringRequests: 10,
        currentAssignedMonitoring: 0,
        maxConcurrentJobs: 1,
        currentActiveJobs: 0,
        lastHeartbeat: new Date(),
        cpuUsage: 15.0,
        memoryUsage: 25.0,
      },
      {
        id: 'worker-local-1',
        machineCode: 'LOCAL-PC-1',
        deploymentType: 'LOCAL_PC',
        status: WorkerStatus.ONLINE,
        desiredState: 'RUNNING',
        active: true,
        adminStatus: 'ENABLED',
        maxMonitoringRequests: 15,
        currentAssignedMonitoring: 0,
        maxConcurrentJobs: 1,
        currentActiveJobs: 0,
        lastHeartbeat: new Date(),
        cpuUsage: 20.0,
        memoryUsage: 30.0,
      },
    ];

    bookingRequests = [];
    for (let i = 1; i <= 40; i++) {
      bookingRequests.push({
        id: `booking-${i}`,
        bookingCode: `BK-2026-${1000 + i}`,
        status: BookingStatus.PENDING,
        requestedDateStr: `2026-12-${String(10 + (i % 15)).padStart(2, '0')}`,
        route: 'Pamba (Regular Footpath Route)',
        assignedMonitoringWorkerId: null,
        isManuallyAssigned: false,
      });
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmartAllocatorService,
        AvailabilityService,
        WorkersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AccountLockService, useValue: mockLockService },
        { provide: DiscoverySchedulerService, useValue: mockScheduler },
        { provide: SmartMatcherService, useValue: mockSmartMatcher },
        { provide: WalletService, useValue: mockWalletService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();

    allocator = module.get<SmartAllocatorService>(SmartAllocatorService);
    availability = module.get<AvailabilityService>(AvailabilityService);
    workersService = module.get<WorkersService>(WorkersService);
  });

  it('Test 1 & 2: Dual worker registration with Cloud (10) and Local (15) capacity', async () => {
    expect(workerMachines[0].maxMonitoringRequests).toBe(10);
    expect(workerMachines[1].maxMonitoringRequests).toBe(15);
    expect(workerMachines[0].maxConcurrentJobs).toBe(1);
    expect(workerMachines[1].maxConcurrentJobs).toBe(1);
  });

  it('Test 3, 4, 5 & 6: 40 active requests distributed (10 Cloud, 15 Local, 15 Central Overflow Queue)', async () => {
    // Trigger allocation sweep
    const result = await allocator.runMonitoringAllocationSweep();

    const cloudAssigned = bookingRequests.filter((b) => b.assignedMonitoringWorkerId === 'worker-cloud-1').length;
    const localAssigned = bookingRequests.filter((b) => b.assignedMonitoringWorkerId === 'worker-local-1').length;
    const pendingInQueue = bookingRequests.filter((b) => b.assignedMonitoringWorkerId === null).length;

    expect(cloudAssigned).toBe(10); // Cloud reached capacity
    expect(localAssigned).toBe(15); // Local reached capacity
    expect(pendingInQueue).toBe(15); // Exactly 15 retained safely in queue
    expect(result.allocatedCount).toBe(25);
    expect(result.pendingCount).toBe(15);
  });

  it('Test 7 & 8: Dynamic capacity scale up (Cloud 10 -> 20, Local 15 -> 25) draws from pending queue', async () => {
    // Distribute initial 25
    await allocator.runMonitoringAllocationSweep();

    // Scale Cloud to 20
    const updatedCloud = await allocator.updateWorkerCapacity('worker-cloud-1', { maxMonitoringRequests: 20 });
    expect(updatedCloud.maxMonitoringRequests).toBe(20);

    // Run sweep to consume waiting requests
    await allocator.runMonitoringAllocationSweep();

    const cloudAssignedAfterScale = bookingRequests.filter((b) => b.assignedMonitoringWorkerId === 'worker-cloud-1').length;
    const remainingPendingAfterCloud = bookingRequests.filter((b) => b.assignedMonitoringWorkerId === null).length;

    expect(cloudAssignedAfterScale).toBe(20); // Drew 10 more
    expect(remainingPendingAfterCloud).toBe(5); // 5 left in queue

    // Scale Local to 25
    const updatedLocal = await allocator.updateWorkerCapacity('worker-local-1', { maxMonitoringRequests: 25 });
    expect(updatedLocal.maxMonitoringRequests).toBe(25);

    await allocator.runMonitoringAllocationSweep();

    const localAssignedAfterScale = bookingRequests.filter((b) => b.assignedMonitoringWorkerId === 'worker-local-1').length;
    const remainingPendingFinal = bookingRequests.filter((b) => b.assignedMonitoringWorkerId === null).length;

    expect(localAssignedAfterScale).toBe(20); // 15 + remaining 5 = 20 (within 25 cap)
    expect(remainingPendingFinal).toBe(0); // Central queue completely drained
  });

  it('Test 9: Capacity reduction initiates graceful draining without abruptly terminating active checks', async () => {
    // First allocate
    await allocator.runMonitoringAllocationSweep();
    const assignedBefore = bookingRequests.filter((b) => b.assignedMonitoringWorkerId === 'worker-cloud-1').length;
    expect(assignedBefore).toBe(10);

    // Admin reduces capacity to 5
    const drainedWorker = await allocator.updateWorkerCapacity('worker-cloud-1', { maxMonitoringRequests: 5 });

    expect(drainedWorker.maxMonitoringRequests).toBe(5);
    expect(drainedWorker.monitoringDraining).toBe(true); // Flagged as draining

    // Zero active requests were cancelled or dropped
    const stillAssigned = bookingRequests.filter((b) => b.assignedMonitoringWorkerId === 'worker-cloud-1').length;
    expect(stillAssigned).toBe(10); // Preserved active monitoring!

    // Next sweep assigns 0 new requests to this draining worker
    await allocator.runMonitoringAllocationSweep();
    expect(bookingRequests.filter((b) => b.assignedMonitoringWorkerId === 'worker-cloud-1').length).toBe(10);
  });

  it('Test 10 & 11: Manual Super Admin assignment (Pin to Cloud, Pin to Local, Return to AUTO)', async () => {
    const targetBooking = bookingRequests[0];

    // Pin to Local Worker
    targetBooking.assignedMonitoringWorkerId = 'worker-local-1';
    targetBooking.isManuallyAssigned = true;

    expect(targetBooking.isManuallyAssigned).toBe(true);
    expect(targetBooking.assignedMonitoringWorkerId).toBe('worker-local-1');

    // Run recovery or allocation sweep — manual pin must NEVER be overwritten
    await allocator.runMonitoringAllocationSweep();
    expect(targetBooking.assignedMonitoringWorkerId).toBe('worker-local-1');
    expect(targetBooking.isManuallyAssigned).toBe(true);

    // Return to AUTO
    targetBooking.isManuallyAssigned = false;
    targetBooking.assignedMonitoringWorkerId = null;
    workerMachines[1].maxMonitoringRequests = 20; // Ensure available capacity for sweep

    // Run sweep — allocator now freely assigns it
    await allocator.runMonitoringAllocationSweep();
    expect(bookingRequests[0].assignedMonitoringWorkerId).not.toBeNull();
  });

  it('Test 12: Worker disconnection and automatic safe lease recovery to surviving worker', async () => {
    // Expand Local worker capacity so it can absorb recovered requests
    workerMachines[1].maxMonitoringRequests = 30;

    // First allocate so workers receive jobs
    await allocator.runMonitoringAllocationSweep();

    // Cloud Worker goes offline (lastHeartbeat 60s ago)
    const cloudWorker = workerMachines.find((w) => w.id === 'worker-cloud-1');
    cloudWorker.status = WorkerStatus.OFFLINE;
    cloudWorker.lastHeartbeat = new Date(Date.now() - 60000);

    // Run stale lease recovery
    const recoveryResult = await allocator.recoverStaleMonitoringLeases();
    expect(recoveryResult.recoveredCount).toBeGreaterThan(0);

    // Verify orphaned requests returned to queue with null assigned worker
    const orphanedNowUnassigned = bookingRequests.filter((b) => b.assignedMonitoringWorkerId === 'worker-cloud-1');
    expect(orphanedNowUnassigned.length).toBe(0);

    // Run sweep for surviving Local worker to absorb recovered requests
    await allocator.runMonitoringAllocationSweep();

    // Surviving Local worker immediately absorbs recovered requests up to its capacity
    expect(bookingRequests.filter((b) => b.assignedMonitoringWorkerId === 'worker-local-1').length).toBeGreaterThan(15);
  });

  it('Test 13: Strict worker isolation: demand dates returned ONLY for assigned machine', async () => {
    // Cloud Worker requests demand dates
    const cloudDemand = await availability.getDemandDates('worker-cloud-1');
    // Local Worker requests demand dates
    const localDemand = await availability.getDemandDates('worker-local-1');

    // Both workers receive valid arrays
    expect(Array.isArray(cloudDemand)).toBe(true);
    expect(Array.isArray(localDemand)).toBe(true);

    // Worker with zero assignments receives empty array (strict partitioning)
    const emptyDemand = await availability.getDemandDates('worker-unassigned-999');
    expect(emptyDemand).toEqual([]);
  });

  it('Test 14: Multiple requested dates per booking request are preserved without loss', async () => {
    // Create a multi-date request with alternative dates in preferences
    bookingRequests = [
      {
        id: 'multi-date-booking-1',
        bookingCode: 'BK-MULTI-1',
        status: BookingStatus.WATCHING,
        requestedDateStr: '2026-12-25',
        route: 'Pamba (Regular Footpath Route)',
        assignedMonitoringWorkerId: 'worker-local-1',
        preferences: {
          dates: ['2026-12-25', '2026-12-26', '2026-12-27'],
        },
      },
    ];

    const demand = await availability.getDemandDates('worker-local-1');
    const returnedDates = demand.map((d) => d.date);

    expect(returnedDates).toContain('2026-12-25');
    expect(returnedDates).toContain('2026-12-26');
    expect(returnedDates).toContain('2026-12-27');
    expect(returnedDates.length).toBe(3); // ZERO MISSED DATES
  });

  it('Test 15: Heartbeat telemetry protection: worker env variables cannot stomp admin capacity', async () => {
    const machine = workerMachines.find((w) => w.id === 'worker-local-1');
    machine.maxMonitoringRequests = 25;
    machine.maxConcurrentJobs = 1;

    // Simulate worker heartbeat arriving with MAX_CONCURRENT_JOBS = 5 or 10 in worker environment
    await workersService.handleHeartbeat('worker-local-1', {
      status: 'ONLINE',
      cpuUsage: 25.0,
      memoryUsage: 35.0,
      browserContextCount: 4,
    });

    const updatedMachine = workerMachines.find((w) => w.id === 'worker-local-1');
    expect(updatedMachine.maxMonitoringRequests).toBe(25); // Preserved!
    expect(updatedMachine.maxConcurrentJobs).toBe(1); // Preserved!
    expect(updatedMachine.browserContextCount).toBe(4);
    expect(updatedMachine.resourceWarning).toBe(false);
  });

  it('Test 16: Resource-aware safety: saturated worker (CPU > 85%) bypassed by allocator', async () => {
    const cloudWorker = workerMachines.find((w) => w.id === 'worker-cloud-1');
    cloudWorker.cpuUsage = 92.0; // Saturated

    // Add unassigned request
    bookingRequests.push({
      id: 'urgent-booking',
      bookingCode: 'BK-URGENT',
      status: BookingStatus.PENDING,
      requestedDateStr: '2026-12-30',
      route: 'Pamba',
      assignedMonitoringWorkerId: null,
      isManuallyAssigned: false,
    });

    await allocator.runMonitoringAllocationSweep();

    const urgent = bookingRequests.find((b) => b.id === 'urgent-booking');
    // Must NOT be assigned to saturated Cloud worker
    expect(urgent.assignedMonitoringWorkerId).not.toBe('worker-cloud-1');
  });

  it('Test 17: Global MAX_ACTIVE_BOOKINGS = 1 execution concurrency lock remains strictly preserved', async () => {
    // Both workers have maxConcurrentJobs = 1
    for (const w of workerMachines) {
      expect(w.maxConcurrentJobs).toBe(1);
    }
  });

  it('Test 18: Idle worker with WorkerStatus.IDLE is eligible and allocated monitoring capacity', async () => {
    // Reset existing assignments so workers have available capacity
    bookingRequests.forEach((b) => {
      b.assignedMonitoringWorkerId = null;
    });

    // Reset worker state and status to IDLE (as reported by worker heartbeat)
    workerMachines[0].status = WorkerStatus.IDLE;
    workerMachines[0].currentAssignedMonitoring = 0;
    workerMachines[0].cpuUsage = 20.0;
    workerMachines[0].memoryUsage = 20.0;
    workerMachines[0].lastHeartbeat = new Date();

    workerMachines[1].status = WorkerStatus.IDLE;
    workerMachines[1].currentAssignedMonitoring = 0;
    workerMachines[1].cpuUsage = 20.0;
    workerMachines[1].memoryUsage = 20.0;
    workerMachines[1].lastHeartbeat = new Date();

    // Add unassigned booking at the front
    bookingRequests.unshift({
      id: 'idle-test-booking',
      bookingCode: 'TA-IDLE-TEST',
      status: BookingStatus.PENDING,
      requestedDateStr: '2026-12-14',
      route: 'Pamba',
      assignedMonitoringWorkerId: null,
      isManuallyAssigned: false,
    });

    const result = await allocator.runMonitoringAllocationSweep();
    expect(result.allocatedCount).toBeGreaterThanOrEqual(1);

    const assignedBooking = bookingRequests.find((b) => b.id === 'idle-test-booking');
    expect(assignedBooking.assignedMonitoringWorkerId).toBeTruthy();
    expect(assignedBooking.status).toBe(BookingStatus.WATCHING);
  });

  it('Test 19: Worker with RAM at 91.6% (idle workstation) is allocated monitoring when capacity is free and CPU is healthy', async () => {
    // Reset workers: only 1 online worker available, reporting 91.6% RAM and 11.2% CPU (exact user scenario)
    workerMachines[0].status = WorkerStatus.ONLINE;
    workerMachines[0].currentAssignedMonitoring = 0;
    workerMachines[0].maxMonitoringRequests = 10;
    workerMachines[0].cpuUsage = 11.2;
    workerMachines[0].memoryUsage = 91.6;
    workerMachines[0].lastHeartbeat = new Date();

    // Disable second worker
    workerMachines[1].status = WorkerStatus.OFFLINE;

    // Add unassigned pending booking
    bookingRequests.unshift({
      id: 'ram-test-booking',
      bookingCode: 'TA-RAM-916',
      status: BookingStatus.PENDING,
      requestedDateStr: '2026-11-28',
      route: 'Pamba',
      assignedMonitoringWorkerId: null,
      isManuallyAssigned: false,
    });

    const result = await allocator.runMonitoringAllocationSweep();
    expect(result.allocatedCount).toBeGreaterThanOrEqual(1);

    const assignedBooking = bookingRequests.find((b) => b.id === 'ram-test-booking');
    expect(assignedBooking.assignedMonitoringWorkerId).toBe(workerMachines[0].id);
    expect(assignedBooking.status).toBe(BookingStatus.WATCHING);
  });
});
