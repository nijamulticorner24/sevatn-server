import { Test, TestingModule } from '@nestjs/testing';
import { AvailabilityService } from './availability.service';
import { SmartMatcherService } from './smart-matcher.service';
import { AccountLockService } from './account-lock.service';
import { DiscoverySchedulerService } from './discovery-scheduler.service';
import { PrismaService } from '../prisma/prisma.service';
import { BookingStatus, AccountStatus, JobType } from '@prisma/client';
import { normalizeDemandKey } from '../common/utils/demand-key';

describe('SEVATN Phase 8 — Availability Discovery & Worker Orchestration Regression Suite', () => {
  let availabilityService: AvailabilityService;
  let discoveryScheduler: DiscoverySchedulerService;
  let smartMatcher: SmartMatcherService;

  let mockBookings: any[] = [];
  let mockSchedules: any[] = [];
  let mockOpportunities: any[] = [];
  let mockJobs: any[] = [];
  let mockAccounts: any[] = [];
  let mockAccountLocks: any[] = [];

  beforeEach(async () => {
    mockBookings = [];
    mockSchedules = [];
    mockOpportunities = [];
    mockJobs = [];
    mockAccounts = [];
    mockAccountLocks = [];

    const mockPrismaService = {
      bookingRequest: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          return mockBookings.filter((b) => {
            const matchStatus = !where.status || where.status.in.includes(b.status);
            const matchDate =
              !where.OR ||
              where.OR.some(
                (orClause: any) =>
                  (orClause.requestedDateStr && b.requestedDateStr === orClause.requestedDateStr) ||
                  (orClause.requestedDate &&
                    b.requestedDate >= orClause.requestedDate.gte &&
                    b.requestedDate <= orClause.requestedDate.lte),
              );
            let matchRoute = true;
            if (where.route?.contains) {
              matchRoute = (b.route || '').toLowerCase().includes(where.route.contains.toLowerCase());
            }
            return matchStatus && matchDate && matchRoute;
          });
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return mockBookings.find((b) => b.id === where.id || b.bookingCode === where.bookingCode) || null;
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          let count = 0;
          for (const b of mockBookings) {
            const matchId = !where.id || b.id === where.id;
            const matchStatus = !where.status || where.status.in.includes(b.status);
            if (matchId && matchStatus) {
              Object.assign(b, data);
              count++;
            }
          }
          return { count };
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const b = mockBookings.find((x) => x.id === where.id);
          if (b) Object.assign(b, data);
          return b;
        }),
      },
      discoverySchedule: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return mockSchedules.find((s) => s.demandKey === where.demandKey) || null;
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const record = { ...data, createdAt: new Date(), updatedAt: new Date(), consecutiveErrors: 0 };
          mockSchedules.push(record);
          return record;
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          let count = 0;
          const now = new Date();
          for (const s of mockSchedules) {
            if (s.demandKey !== where.demandKey) continue;

            let matchNext = true;
            if (where.nextCheckAt?.lte && s.nextCheckAt > where.nextCheckAt.lte) {
              matchNext = false;
            }

            let matchLock = true;
            if (where.OR) {
              matchLock = where.OR.some((clause: any) => {
                if (clause.lockedBy === null && (s.lockedBy === null || s.lockedBy === undefined)) return true;
                if (clause.lockedBy && s.lockedBy === clause.lockedBy) return true;
                if (clause.lockExpiresAt?.lte && s.lockExpiresAt && s.lockExpiresAt <= clause.lockExpiresAt.lte) return true;
                return false;
              });
            }

            if (matchNext && matchLock) {
              if (data.consecutiveErrors && typeof data.consecutiveErrors === 'object' && 'increment' in data.consecutiveErrors) {
                s.consecutiveErrors = (s.consecutiveErrors || 0) + data.consecutiveErrors.increment;
              } else if (data.consecutiveErrors !== undefined) {
                s.consecutiveErrors = data.consecutiveErrors;
              }

              const copyData = { ...data };
              delete copyData.consecutiveErrors;
              Object.assign(s, copyData);
              count++;
            }
          }
          return { count };
        }),
      },
      availabilityOpportunity: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return mockOpportunities.find((o) => o.idempotencyKey === where.idempotencyKey) || null;
        }),
        upsert: jest.fn().mockImplementation(({ where, create, update }) => {
          const existing = mockOpportunities.find((o) => o.idempotencyKey === where.idempotencyKey);
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const record = { id: `opp-${mockOpportunities.length + 1}`, ...create };
          mockOpportunities.push(record);
          return record;
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          let count = 0;
          for (const opp of mockOpportunities) {
            const matchId = !where.id || opp.id === where.id;
            let matchOr = true;
            if (where.OR) {
              matchOr = where.OR.some((clause: any) => {
                if (clause.status && opp.status !== clause.status) return false;
                if ('matchedBookingId' in clause && opp.matchedBookingId !== clause.matchedBookingId) return false;
                return true;
              });
            }
            if (matchId && matchOr) {
              Object.assign(opp, data);
              count++;
            }
          }
          return { count };
        }),
      },
      bookingJob: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          return (
            mockJobs.find((j) => {
              if (where.bookingRequestId && j.bookingRequestId !== where.bookingRequestId) return false;
              if (where.jobType && j.jobType !== where.jobType) return false;
              if (where.status?.notIn && where.status.notIn.includes(j.status)) return false;
              if (where.status?.in && !where.status.in.includes(j.status)) return false;
              return true;
            }) || null
          );
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const j = mockJobs.find((x) => x.id === where.id);
          if (j) Object.assign(j, data);
          return j;
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const j = { id: `job-${mockJobs.length + 1}`, ...data };
          mockJobs.push(j);
          return j;
        }),
      },
      $transaction: jest.fn().mockImplementation((callback) => callback(mockPrismaService)),
    };

    const mockAccountLock = {
      isLocked: jest.fn().mockImplementation((accId) => Promise.resolve(mockAccountLocks.includes(accId))),
      acquireLock: jest.fn().mockImplementation((accId) => {
        mockAccountLocks.push(accId);
        return Promise.resolve(true);
      }),
      releaseLock: jest.fn().mockImplementation((accId) => {
        mockAccountLocks = mockAccountLocks.filter((id) => id !== accId);
        return Promise.resolve(true);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AvailabilityService,
        DiscoverySchedulerService,
        SmartMatcherService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: AccountLockService, useValue: mockAccountLock },
      ],
    }).compile();

    availabilityService = module.get<AvailabilityService>(AvailabilityService);
    discoveryScheduler = module.get<DiscoverySchedulerService>(DiscoverySchedulerService);
    smartMatcher = module.get<SmartMatcherService>(SmartMatcherService);
  });

  // Scenario 1: Same date and route requested by multiple customers
  it('1. Same date and route requested by multiple customers produces grouped demand without starvation', async () => {
    mockBookings.push(
      {
        id: 'b-cust1',
        bookingCode: 'TA-CUST1',
        requestedDateStr: '2026-11-27',
        requestedDate: new Date('2026-11-27T00:00:00Z'),
        route: 'Pamba - Marakkoottam - 4 Kms',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-10-30T10:00:00Z'),
        accountId: 'acc-1',
        account: { id: 'acc-1', status: AccountStatus.VERIFIED, username: '8098697141' },
        nomineeName: 'Nija',
      },
      {
        id: 'b-cust2',
        bookingCode: 'TA-CUST2',
        requestedDateStr: '2026-11-27',
        requestedDate: new Date('2026-11-27T00:00:00Z'),
        route: 'Pamba - Marakkoottam - 4 Kms',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-10-30T10:05:00Z'),
        accountId: 'acc-2',
        account: { id: 'acc-2', status: AccountStatus.VERIFIED, username: '9840123456' },
        nomineeName: 'Kumar',
      },
    );

    const demandDates = await availabilityService.getDemandDates();
    expect(demandDates).toHaveLength(1);
    expect(demandDates[0].demandKey).toBe('2026-11-27:PAMBA');
    expect(demandDates[0].pendingCount).toBe(2);
    expect(demandDates[0].isDue).toBe(true);
  });

  // Scenario 2: Same date and route discovered repeatedly - interval throttling prevents duplicate scans
  it('2. Same date and route discovered repeatedly applies interval throttling and prevents duplicate scans', async () => {
    const demandKey = '2026-11-27:PAMBA';
    await discoveryScheduler.ensureSchedule('2026-11-27', 'Pamba - Marakkoottam - 4 Kms');

    // First scan claims successfully
    const claim1 = await discoveryScheduler.claimDemandScan(demandKey, 'worker-1');
    expect(claim1.claimed).toBe(true);

    // Release as AVAILABLE (triggers 60s interval)
    await discoveryScheduler.releaseDemandScan(demandKey, 'worker-1', 'AVAILABLE', 450);

    // Immediate second scan is SKIPPED due to interval throttling
    const claim2 = await discoveryScheduler.claimDemandScan(demandKey, 'worker-1');
    expect(claim2.claimed).toBe(false);
    expect(claim2.message).toBe('INTERVAL_THROTTLED');

    const metrics = discoveryScheduler.getMetrics();
    expect(metrics.duplicateScansPrevented).toBe(1);
  });

  // Scenario 3: New customer added to an already monitored date allows immediate discovery
  it('3. New customer added to an already monitored date is discovered without delay', async () => {
    mockBookings.push({
      id: 'b-newcust',
      bookingCode: 'TA-NEWCUST',
      requestedDateStr: '2026-11-30',
      requestedDate: new Date('2026-11-30T00:00:00Z'),
      route: 'Pamba - Marakkoottam - 4 Kms',
      status: BookingStatus.PENDING,
      accountId: 'acc-new',
      account: { id: 'acc-new', status: AccountStatus.VERIFIED, username: '9999999999' },
      nomineeName: 'Devotee',
    });

    const demandDates = await availabilityService.getDemandDates();
    expect(demandDates).toHaveLength(1);
    expect(demandDates[0].demandKey).toBe('2026-11-30:PAMBA');
    expect(demandDates[0].isDue).toBe(true);
  });

  // Scenario 4: Availability changes from unavailable to available
  it('4. Availability state transitions from UNAVAILABLE (30s) to AVAILABLE (60s) with accurate scheduling', async () => {
    const demandKey = '2026-11-27:PAMBA';
    await discoveryScheduler.ensureSchedule('2026-11-27', 'Pamba - Marakkoottam - 4 Kms');

    // Scan 1: Unavailable
    await discoveryScheduler.claimDemandScan(demandKey, 'worker-1');
    await discoveryScheduler.releaseDemandScan(demandKey, 'worker-1', 'UNAVAILABLE', 300);

    const schedUnavailable = await discoveryScheduler.ensureSchedule('2026-11-27', 'Pamba - Marakkoottam - 4 Kms');
    expect(schedUnavailable.status).toBe('UNAVAILABLE');

    // Fast-forward nextCheckAt
    schedUnavailable.nextCheckAt = new Date(Date.now() - 1000);

    // Scan 2: Discovered Available
    const claim2 = await discoveryScheduler.claimDemandScan(demandKey, 'worker-1');
    expect(claim2.claimed).toBe(true);
    await discoveryScheduler.releaseDemandScan(demandKey, 'worker-1', 'AVAILABLE', 400);

    const schedAvailable = await discoveryScheduler.ensureSchedule('2026-11-27', 'Pamba - Marakkoottam - 4 Kms');
    expect(schedAvailable.status).toBe('AVAILABLE');
  });

  // Scenario 5: Existing booking already queued is not duplicated
  it('5. Existing booking already queued is not duplicate-matched or given duplicate jobs', async () => {
    mockBookings.push({
      id: 'b-queued',
      bookingCode: 'TA-QUEUED',
      requestedDateStr: '2026-11-27',
      requestedDate: new Date('2026-11-27T00:00:00Z'),
      route: 'Pamba',
      status: BookingStatus.EXECUTION_QUEUED,
      accountId: 'acc-1',
      account: { id: 'acc-1', status: AccountStatus.VERIFIED, username: '8098697141' },
      nomineeName: 'Nija',
    });

    mockJobs.push({
      id: 'job-active-1',
      bookingRequestId: 'b-queued',
      jobType: JobType.BOOKING_EXECUTION,
      status: BookingStatus.QUEUED,
    });

    const res = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-27',
      route: 'Pamba',
    });

    expect(res.matched).toBe(false);
    expect(mockJobs).toHaveLength(1); // No new job created
  });

  // Scenario 6: Confirmed booking (SUCCESS) allows next pending customer on same date to be matched
  it('6. Confirmed booking (SUCCESS) does not block a subsequent customer requesting the same date/route', async () => {
    // Previous booking succeeded
    mockBookings.push(
      {
        id: 'b-success-10051',
        bookingCode: 'TA-10051',
        requestedDateStr: '2026-11-27',
        requestedDate: new Date('2026-11-27T00:00:00Z'),
        route: 'Pamba - Marakkoottam - 4 Kms',
        status: BookingStatus.SUCCESS,
        accountId: 'acc-1',
        account: { id: 'acc-1', status: AccountStatus.VERIFIED, username: '8098697141' },
        nomineeName: 'Nija',
      },
      {
        id: 'b-pending-10055',
        bookingCode: 'TA-10055',
        requestedDateStr: '2026-11-27',
        requestedDate: new Date('2026-11-27T00:00:00Z'),
        route: 'Pamba - Marakkoottam - 4 Kms',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-10-30T12:00:00Z'),
        accountId: 'acc-2',
        account: { id: 'acc-2', status: AccountStatus.VERIFIED, username: '9840123456' },
        nomineeName: 'Subramanian',
      },
    );

    // Existing opportunity was matched to TA-10051
    mockOpportunities.push({
      id: 'opp-2026-11-27',
      idempotencyKey: '2026-11-27|Pamba - Marakkoottam - 4 Kms',
      date: '2026-11-27',
      route: 'Pamba - Marakkoottam - 4 Kms',
      timeSlot: 'DATE_ONLY',
      status: 'MATCHED',
      matchedBookingId: 'b-success-10051',
    });

    const res = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-27',
      route: 'Pamba - Marakkoottam - 4 Kms',
    });

    expect(res.matched).toBe(true);
    expect(res.bookingCode).toBe('TA-10055');
    expect(res.bookingId).toBe('b-pending-10055');

    // Execution job was created for TA-10055
    const job = mockJobs.find((j) => j.bookingRequestId === 'b-pending-10055');
    expect(job).toBeDefined();
    expect(job.status).toBe(BookingStatus.QUEUED);
  });

  // Scenario 7: Account restricted skips booking safely
  it('7. Restricted official account (DISABLED or PREVIOUS_BOOKING_RESTRICTED) is safely skipped', async () => {
    mockBookings.push({
      id: 'b-restr',
      bookingCode: 'TA-RESTR',
      requestedDateStr: '2026-11-27',
      requestedDate: new Date('2026-11-27T00:00:00Z'),
      route: 'Pamba',
      status: BookingStatus.PENDING,
      accountId: 'acc-restr',
      account: { id: 'acc-restr', status: AccountStatus.DISABLED, username: 'disabled_user' },
      nomineeName: 'Pilgrim',
    });

    const res = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-27',
      route: 'Pamba',
    });

    expect(res.matched).toBe(false);
    expect(mockJobs).toHaveLength(0);
  });

  // Scenario 8: Worker crash/restart during discovery - stale lock expires and is safely reclaimed
  it('8. Worker crash during discovery leaves lease that auto-expires and is reclaimed by another worker', async () => {
    const demandKey = '2026-11-27:PAMBA';
    await discoveryScheduler.ensureSchedule('2026-11-27', 'Pamba');

    // Worker 1 claims lock
    await discoveryScheduler.claimDemandScan(demandKey, 'worker-crashed');

    const sched = await discoveryScheduler.ensureSchedule('2026-11-27', 'Pamba');
    expect(sched.lockedBy).toBe('worker-crashed');

    // Fast-forward past lock TTL
    sched.lockExpiresAt = new Date(Date.now() - 5000);

    // Worker 2 reclaims the expired lock cleanly
    const claim = await discoveryScheduler.claimDemandScan(demandKey, 'worker-survivor');
    expect(claim.claimed).toBe(true);
    expect(sched.lockedBy).toBe('worker-survivor');
  });

  // Scenario 9: Metrics tracking records scans, duplicates prevented, and browser launches saved
  it('9. Metrics tracking accurately reflects scans, duplicate preventions, and queue completions', async () => {
    const metrics1 = discoveryScheduler.getMetrics();
    expect(metrics1.scansTotal).toBe(0);

    discoveryScheduler.recordBrowserLaunchSaved(5);
    discoveryScheduler.recordJobCreated(2);
    discoveryScheduler.recordBookingsMatched(2);

    const metrics2 = discoveryScheduler.getMetrics();
    expect(metrics2.browserLaunchesSaved).toBe(5);
    expect(metrics2.executionJobsCreated).toBe(2);
    expect(metrics2.eligibleBookingsMatched).toBe(2);
  });

  // Scenario 10: Discovery lock expiry - ownership check prevents accidental release by another worker
  it('10. Ownership check on release prevents a non-owner worker from releasing another workers active scan', async () => {
    const demandKey = '2026-11-27:PAMBA';
    await discoveryScheduler.ensureSchedule('2026-11-27', 'Pamba');

    await discoveryScheduler.claimDemandScan(demandKey, 'worker-owner');

    // Non-owner worker attempts release
    await discoveryScheduler.releaseDemandScan(demandKey, 'worker-impostor', 'AVAILABLE', 200);

    const sched = await discoveryScheduler.ensureSchedule('2026-11-27', 'Pamba');
    // Lock must STILL be owned by worker-owner
    expect(sched.lockedBy).toBe('worker-owner');
  });

  // Scenario 11: Multiple worker processes claiming concurrently - exactly one worker gets the claim
  it('11. Multiple concurrent worker processes: exactly one acquires discovery lock', async () => {
    const demandKey = '2026-11-27:PAMBA';
    await discoveryScheduler.ensureSchedule('2026-11-27', 'Pamba');

    const [claimA, claimB] = await Promise.all([
      discoveryScheduler.claimDemandScan(demandKey, 'worker-node-1'),
      discoveryScheduler.claimDemandScan(demandKey, 'worker-node-2'),
    ]);

    // One must succeed, one must fail
    const successCount = (claimA.claimed ? 1 : 0) + (claimB.claimed ? 1 : 0);
    expect(successCount).toBe(1);
  });

  // Scenario 12: Portal timeout and exponential backoff
  it('12. Portal timeout triggers exponential backoff on subsequent nextCheckAt', async () => {
    const demandKey = '2026-11-27:PAMBA';
    await discoveryScheduler.ensureSchedule('2026-11-27', 'Pamba');

    // Error 1: 15s backoff
    await discoveryScheduler.claimDemandScan(demandKey, 'worker-1');
    await discoveryScheduler.releaseDemandScan(demandKey, 'worker-1', 'ERROR', 5000);

    const sched1 = await discoveryScheduler.ensureSchedule('2026-11-27', 'Pamba');
    expect(sched1.consecutiveErrors).toBe(1);
    const delay1 = sched1.nextCheckAt.getTime() - Date.now();
    expect(delay1).toBeGreaterThanOrEqual(14000);
    expect(delay1).toBeLessThanOrEqual(16000);

    // Fast-forward
    sched1.nextCheckAt = new Date(Date.now() - 1000);

    // Error 2: 30s backoff
    await discoveryScheduler.claimDemandScan(demandKey, 'worker-1');
    await discoveryScheduler.releaseDemandScan(demandKey, 'worker-1', 'ERROR', 5000);

    const sched2 = await discoveryScheduler.ensureSchedule('2026-11-27', 'Pamba');
    expect(sched2.consecutiveErrors).toBe(2);
    const delay2 = sched2.nextCheckAt.getTime() - Date.now();
    expect(delay2).toBeGreaterThanOrEqual(29000);
    expect(delay2).toBeLessThanOrEqual(31000);
  });
});

