import { Test, TestingModule } from '@nestjs/testing';
import { SmartMatcherService, AvailabilityEventPayload } from './smart-matcher.service';
import { AccountLockService } from './account-lock.service';
import { PrismaService } from '../prisma/prisma.service';
import { BookingStatus, JobType } from '@prisma/client';

describe('Smart Availability Discovery & Instant Booking Matching', () => {
  let smartMatcher: SmartMatcherService;
  let accountLockService: AccountLockService;
  let prisma: PrismaService;

  // In-memory mock database store
  let mockBookings: any[] = [];
  let mockOpportunities: any[] = [];
  let mockAccountLocks: any[] = [];
  let mockBookingJobs: any[] = [];

  beforeEach(async () => {
    mockBookings = [];
    mockOpportunities = [];
    mockAccountLocks = [];
    mockBookingJobs = [];

    const mockPrismaService = {
      availabilityOpportunity: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return mockOpportunities.find((o) => o.idempotencyKey === where.idempotencyKey) || null;
        }),
        upsert: jest.fn().mockImplementation(({ where, create, update }) => {
          const existing = mockOpportunities.find((o) => o.idempotencyKey === where.idempotencyKey);
          if (existing) {
            Object.assign(existing, update);
            return existing;
          } else {
            const newOpp = { id: `opp-${mockOpportunities.length + 1}`, ...create };
            mockOpportunities.push(newOpp);
            return newOpp;
          }
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const opp = mockOpportunities.find((o) => o.id === where.id);
          if (opp) Object.assign(opp, data);
          return opp;
        }),
      },
      bookingRequest: {
        findMany: jest.fn().mockImplementation(({ where, orderBy }) => {
          let results = mockBookings.filter((b) => {
            const matchStatus = where.status?.in?.includes(b.status);
            const matchDate =
              (where.requestedDateStr && b.requestedDateStr === where.requestedDateStr) ||
              (where.OR && where.OR.some((orClause: any) => orClause.requestedDateStr === b.requestedDateStr));
            return matchStatus && matchDate;
          });
          if (orderBy?.createdAt === 'asc') {
            results.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          }
          return results;
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return mockBookings.find((b) => b.id === where.id) || null;
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const b = mockBookings.find((item) => item.id === where.id);
          if (b) Object.assign(b, data);
          return b;
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          let count = 0;
          for (const b of mockBookings) {
            if (b.id === where.id && where.status?.in?.includes(b.status)) {
              Object.assign(b, data);
              count++;
            }
          }
          return { count };
        }),
      },
      bookingJob: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          return (
            mockBookingJobs.find(
              (j) => j.bookingRequestId === where.bookingRequestId && where.status?.in?.includes(j.status),
            ) || null
          );
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const j = mockBookingJobs.find((item) => item.id === where.id);
          if (j) Object.assign(j, data);
          return j;
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const newJob = { id: `job-${mockBookingJobs.length + 1}`, ...data };
          mockBookingJobs.push(newJob);
          return newJob;
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          let count = 0;
          for (const j of mockBookingJobs) {
            if (j.bookingRequestId === where.bookingRequestId) {
              Object.assign(j, data);
              count++;
            }
          }
          return { count };
        }),
      },
      accountLock: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          return mockAccountLocks.find((l) => l.accountId === where.accountId) || null;
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const existing = mockAccountLocks.find((l) => l.accountId === data.accountId);
          if (existing) {
            throw new Error('AccountLock unique constraint failed');
          }
          mockAccountLocks.push(data);
          return data;
        }),
        deleteMany: jest.fn().mockImplementation(({ where }) => {
          const initialLen = mockAccountLocks.length;
          mockAccountLocks = mockAccountLocks.filter((l) => {
            if (where.accountId && l.accountId !== where.accountId) return true;
            return false;
          });
          return { count: initialLen - mockAccountLocks.length };
        }),
      },
      $transaction: jest.fn().mockImplementation(async (cb) => {
        return cb(mockPrismaService);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmartMatcherService,
        AccountLockService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    smartMatcher = module.get<SmartMatcherService>(SmartMatcherService);
    accountLockService = module.get<AccountLockService>(AccountLockService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  // TEST 1 & 2: 100 users across 4 dates. 22 Nov FULL, 23 Nov AVAILABLE
  it('TEST 1 & 2: Should match 23 Nov booking without starving behind 22 Nov queue', async () => {
    // 40 bookings for 22 Nov
    for (let i = 1; i <= 40; i++) {
      mockBookings.push({
        id: `b-22-${i}`,
        bookingCode: `TA-2200${i}`,
        requestedDate: new Date('2026-11-22T00:00:00.000Z'),
        requestedDateStr: '2026-11-22',
        route: 'Pamba',
        status: BookingStatus.PENDING,
        createdAt: new Date(Date.now() - (100 - i) * 60000),
      });
    }

    // 25 bookings for 23 Nov
    for (let i = 1; i <= 25; i++) {
      mockBookings.push({
        id: `b-23-${i}`,
        bookingCode: `TA-2300${i}`,
        requestedDate: new Date('2026-11-23T00:00:00.000Z'),
        requestedDateStr: '2026-11-23',
        route: 'Pamba',
        status: BookingStatus.PENDING,
        createdAt: new Date(Date.now() - (50 - i) * 60000),
      });
    }

    // Discovered availability for 23 Nov
    const event: AvailabilityEventPayload = {
      date: '2026-11-23',
      route: 'Pamba',
      timeSlot: '10:00-11:00',
    };

    const matchResult = await smartMatcher.matchAvailabilityEvent(event);

    expect(matchResult.matched).toBe(true);
    expect(matchResult.bookingId).toBe('b-23-1'); // Oldest 23 Nov booking

    // Verify 23 Nov booking transitioned to EXECUTION_QUEUED
    const matchedBooking = mockBookings.find((b) => b.id === 'b-23-1');
    expect(matchedBooking.status).toBe(BookingStatus.EXECUTION_QUEUED);
    expect(matchedBooking.selectedTime).toBe('10:00-11:00');

    // Verify 22 Nov bookings remain strictly PENDING
    const b22Count = mockBookings.filter((b) => b.requestedDateStr === '2026-11-22' && b.status === BookingStatus.PENDING).length;
    expect(b22Count).toBe(40);
  });

  // TEST 3: Never change a user's requested date
  it('TEST 3: Should NEVER change User A requested date when another date becomes available', async () => {
    mockBookings.push({
      id: 'user-a',
      bookingCode: 'TA-USER-A',
      requestedDate: new Date('2026-11-22T00:00:00.000Z'),
      requestedDateStr: '2026-11-22',
      route: 'Pamba',
      status: BookingStatus.PENDING,
      createdAt: new Date(),
    });

    const event: AvailabilityEventPayload = {
      date: '2026-11-23',
      route: 'Pamba',
      timeSlot: '10:00-11:00',
    };

    const res = await smartMatcher.matchAvailabilityEvent(event);
    expect(res.matched).toBe(false);

    const userABooking = mockBookings.find((b) => b.id === 'user-a');
    expect(userABooking.status).toBe(BookingStatus.PENDING);
    expect(userABooking.requestedDateStr).toBe('2026-11-22');
  });

  // TEST 4 & Fairness: Oldest eligible pending booking gets priority
  it('TEST 4: Deterministic fairness - oldest booking (createdAt ASC) is claimed first', async () => {
    mockBookings.push(
      {
        id: 'b-201',
        bookingCode: 'TA-201',
        requestedDateStr: '2026-11-23',
        requestedDate: new Date('2026-11-23T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-11-23T09:01:00Z'),
      },
      {
        id: 'b-202',
        bookingCode: 'TA-202',
        requestedDateStr: '2026-11-23',
        requestedDate: new Date('2026-11-23T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-11-23T09:03:00Z'),
      },
    );

    const res = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-23',
      route: 'Pamba',
      timeSlot: '10:00-11:00',
    });

    expect(res.matched).toBe(true);
    expect(res.bookingId).toBe('b-201'); // b-201 was created earlier
  });

  // TEST 5: Temporary Slot Lost Recovery
  it('TEST 5: If slot is lost, booking is safely returned to PENDING with requestedDate intact', async () => {
    const booking = {
      id: 'b-race',
      bookingCode: 'TA-RACE',
      requestedDate: new Date('2026-11-23T00:00:00Z'),
      requestedDateStr: '2026-11-23',
      route: 'Pamba',
      status: BookingStatus.CLAIMED,
      createdAt: new Date(),
    };
    mockBookings.push(booking);

    await smartMatcher.returnToPendingOnSlotLoss('b-race', 'Slot lost prior to checkout');

    expect(booking.status).toBe(BookingStatus.PENDING);
    expect(booking.requestedDateStr).toBe('2026-11-23');
  });

  // TEST 6: Same Account Protection / Account-level Lock
  it('TEST 6: Same official account cannot execute multiple bookings simultaneously', async () => {
    mockBookings.push(
      {
        id: 'b-acc-1',
        bookingCode: 'TA-ACC1',
        accountId: 'official-account-A',
        requestedDateStr: '2026-11-23',
        requestedDate: new Date('2026-11-23T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-11-23T08:00:00Z'),
      },
      {
        id: 'b-acc-2',
        bookingCode: 'TA-ACC2',
        accountId: 'official-account-A', // Same account
        requestedDateStr: '2026-11-23',
        requestedDate: new Date('2026-11-23T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-11-23T08:05:00Z'),
      },
      {
        id: 'b-acc-3',
        bookingCode: 'TA-ACC3',
        accountId: 'official-account-B', // Different account
        requestedDateStr: '2026-11-23',
        requestedDate: new Date('2026-11-23T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-11-23T08:10:00Z'),
      },
    );

    // First match claims b-acc-1 and locks official-account-A
    const res1 = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-23',
      route: 'Pamba',
      timeSlot: '10:00-11:00',
    });
    expect(res1.matched).toBe(true);
    expect(res1.bookingId).toBe('b-acc-1');

    // Second slot on same date matches b-acc-3 (skipping b-acc-2 whose account is busy!)
    const res2 = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-23',
      route: 'Pamba',
      timeSlot: '11:00-12:00',
    });
    expect(res2.matched).toBe(true);
    expect(res2.bookingId).toBe('b-acc-3');

    // Booking 2 is marked WAITING_FOR_ACCOUNT
    const b2 = mockBookings.find((b) => b.id === 'b-acc-2');
    expect(b2.status).toBe(BookingStatus.WAITING_FOR_ACCOUNT);
  });

  // TEST 8: Availability Event Idempotency
  it('TEST 8: Duplicate availability event does NOT trigger duplicate execution', async () => {
    mockBookings.push({
      id: 'b-idem',
      bookingCode: 'TA-IDEM',
      requestedDateStr: '2026-11-23',
      requestedDate: new Date('2026-11-23T00:00:00Z'),
      route: 'Pamba',
      status: BookingStatus.PENDING,
      createdAt: new Date(),
    });

    const event = {
      date: '2026-11-23',
      route: 'Pamba',
      timeSlot: '10:00-11:00',
    };

    // First fire
    const res1 = await smartMatcher.matchAvailabilityEvent(event);
    expect(res1.matched).toBe(true);

    // Second fire (duplicate event for exact same slot)
    const res2 = await smartMatcher.matchAvailabilityEvent(event);
    expect(res2.matched).toBe(false);
    expect(res2.message).toContain('already claimed');
  });
});
