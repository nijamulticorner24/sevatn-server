import { Test, TestingModule } from '@nestjs/testing';
import { SmartMatcherService, AvailabilityEventPayload } from './smart-matcher.service';
import { AccountLockService } from './account-lock.service';
import { PrismaService } from '../prisma/prisma.service';
import { BookingStatus, JobType, AccountStatus } from '@prisma/client';

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
      bookingRequest: {
        findMany: jest.fn().mockImplementation(({ where, orderBy }) => {
          let results = mockBookings.filter((b) => {
            const matchStatus = where.status?.in?.includes(b.status);
            const matchDate =
              (where.requestedDateStr && b.requestedDateStr === where.requestedDateStr) ||
              (where.OR && where.OR.some((orClause: any) => orClause.requestedDateStr === b.requestedDateStr));
            let matchRoute = true;
            if (where.route?.contains) {
              matchRoute = b.route.toLowerCase().includes(where.route.contains.toLowerCase());
            }
            return matchStatus && matchDate && matchRoute;
          });
          if (orderBy?.createdAt === 'asc') {
            results.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          }
          return results.map((b) => ({
            accountId: b.accountId !== undefined ? b.accountId : 'acc-default',
            account: b.account !== undefined ? b.account : { id: b.accountId || 'acc-default', status: AccountStatus.VERIFIED },
            pilgrims: b.pilgrims !== undefined ? b.pilgrims : [{ id: 'p-1', fullName: 'Devotee', age: 30, gender: 'MALE', idType: 'AADHAAR', idNumber: '123456789012' }],
            nomineeName: b.nomineeName !== undefined ? b.nomineeName : 'Guardian',
            nomineeAge: b.nomineeAge !== undefined ? b.nomineeAge : 40,
            nomineeRelationship: b.nomineeRelationship !== undefined ? b.nomineeRelationship : 'FATHER',
            nomineePhone: b.nomineePhone !== undefined ? b.nomineePhone : '9876543210',
            ...b,
          }));
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
            mockBookingJobs.find((j) => {
              if (where.bookingRequestId && j.bookingRequestId !== where.bookingRequestId) return false;
              if (where.jobType && j.jobType !== where.jobType) return false;
              if (where.status?.in && !where.status.in.includes(j.status)) return false;
              if (where.OR) {
                const orMatch = where.OR.some((clause: any) => {
                  if (clause.status?.notIn && !clause.status.notIn.includes(j.status)) return true;
                  if (clause.leaseExpiresAt?.gt && j.leaseExpiresAt && new Date(j.leaseExpiresAt) > clause.leaseExpiresAt.gt) return true;
                  return false;
                });
                return orMatch;
              }
              return true;
            }) || null
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
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return mockAccountLocks.find((l) => l.accountId === where.accountId) || null;
        }),
        findFirst: jest.fn().mockImplementation(({ where }) => {
          return (
            mockAccountLocks.find((l) => {
              if (where.accountId && l.accountId !== where.accountId) return false;
              if (where.expiresAt?.gt && l.expiresAt <= where.expiresAt.gt) return false;
              if (where.bookingId?.not && l.bookingId === where.bookingId.not) return false;
              return true;
            }) || null
          );
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const existing = mockAccountLocks.find((l) => l.accountId === data.accountId);
          if (existing) {
            throw new Error('AccountLock unique constraint failed');
          }
          mockAccountLocks.push(data);
          return data;
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const existing = mockAccountLocks.find((l) => l.accountId === where.accountId);
          if (existing) {
            Object.assign(existing, data);
            return existing;
          }
          throw new Error('Record not found');
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          let count = 0;
          for (const l of mockAccountLocks) {
            const matchAcc = !where.accountId || l.accountId === where.accountId;
            const matchExp = !where.expiresAt?.lte || l.expiresAt <= where.expiresAt.lte;
            if (matchAcc && matchExp) {
              Object.assign(l, data);
              count++;
            }
          }
          return { count };
        }),
        deleteMany: jest.fn().mockImplementation(({ where }) => {
          const initialLen = mockAccountLocks.length;
          mockAccountLocks = mockAccountLocks.filter((l) => {
            if (where.accountId && l.accountId !== where.accountId) return true;
            if (where.expiresAt?.lte && l.expiresAt > where.expiresAt.lte) return true;
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

  // TEST 9: Readiness Gate - SmartMatcher skips bookings with unverified accounts or missing nominee
  it('TEST 9: Readiness Gate - skips bookings lacking verified account or nominee details', async () => {
    mockBookings.push(
      {
        id: 'b-unverified',
        bookingCode: 'TA-UNVERIFIED',
        requestedDateStr: '2026-11-23',
        requestedDate: new Date('2026-11-23T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-11-23T08:00:00Z'),
        accountId: 'acc-unverified',
        account: { id: 'acc-unverified', status: AccountStatus.UNVERIFIED },
        nomineeName: 'Guardian 1',
      },
      {
        id: 'b-no-nominee',
        bookingCode: 'TA-NO-NOMINEE',
        requestedDateStr: '2026-11-23',
        requestedDate: new Date('2026-11-23T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-11-23T08:05:00Z'),
        accountId: 'acc-no-nominee',
        nomineeName: null,
        pilgrims: [],
      },
      {
        id: 'b-ready',
        bookingCode: 'TA-READY',
        requestedDateStr: '2026-11-23',
        requestedDate: new Date('2026-11-23T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-11-23T08:15:00Z'),
        accountId: 'acc-verified',
        account: { id: 'acc-verified', status: AccountStatus.VERIFIED },
        nomineeName: 'Guardian 2',
        nomineeAge: 45,
        nomineeRelationship: 'BROTHER',
        nomineePhone: '9876543210',
      },
    );

    const matchRes = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-23',
      route: 'Pamba',
      timeSlot: '10:00-11:00',
    });

    // It should skip unverified, no-pilgrims, and no-nominee, and match the ready booking
    expect(matchRes.matched).toBe(true);
    expect(matchRes.bookingId).toBe('b-ready');
  });

  // REGRESSION 1: Existing opportunity matched to an active booking is not reassigned
  it('REGRESSION 1: Existing opportunity matched to an active booking is NOT reassigned', async () => {
    mockOpportunities.push({
      id: 'opp-act',
      idempotencyKey: '2026-11-25|Pamba',
      date: '2026-11-25',
      route: 'Pamba',
      timeSlot: 'DATE_ONLY',
      status: 'MATCHED',
      matchedBookingId: 'b-active',
    });

    mockBookings.push(
      {
        id: 'b-active',
        bookingCode: 'TA-ACTIVE',
        requestedDateStr: '2026-11-25',
        requestedDate: new Date('2026-11-25T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.EXECUTION_QUEUED,
        createdAt: new Date('2026-11-25T08:00:00Z'),
      },
      {
        id: 'b-pending',
        bookingCode: 'TA-PENDING',
        requestedDateStr: '2026-11-25',
        requestedDate: new Date('2026-11-25T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-11-25T08:10:00Z'),
      },
    );

    const res = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-25',
      route: 'Pamba',
    });

    expect(res.matched).toBe(false);
    expect(res.message).toContain('already claimed/matched by another booking');

    // Opportunity remains matched to the active booking
    const opp = mockOpportunities.find((o) => o.id === 'opp-act');
    expect(opp.matchedBookingId).toBe('b-active');

    // Pending booking remains untouched
    const pendingBooking = mockBookings.find((b) => b.id === 'b-pending');
    expect(pendingBooking.status).toBe(BookingStatus.PENDING);
  });

  // REGRESSION 2: Existing opportunity matched to a cancelled booking can be safely reassigned
  it('REGRESSION 2: Existing opportunity matched to a cancelled booking is safely reassigned to eligible pending booking', async () => {
    mockOpportunities.push({
      id: 'opp-stale',
      idempotencyKey: '2026-11-18|Pamba - Marakkoottam - 4 Kms',
      date: '2026-11-18',
      route: 'Pamba - Marakkoottam - 4 Kms',
      timeSlot: 'DATE_ONLY',
      status: 'MATCHED',
      matchedBookingId: 'b-cancelled',
    });

    mockBookings.push(
      {
        id: 'b-cancelled',
        bookingCode: 'TA-10024',
        requestedDateStr: '2026-11-18',
        requestedDate: new Date('2026-11-18T00:00:00Z'),
        route: 'Pamba (Regular Footpath Route)',
        status: BookingStatus.CANCELLED,
        createdAt: new Date('2026-11-18T07:00:00Z'),
      },
      {
        id: 'b-10033',
        bookingCode: 'TA-10033',
        requestedDateStr: '2026-11-18',
        requestedDate: new Date('2026-11-18T00:00:00Z'),
        route: 'Pamba (Regular Footpath Route)',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-11-18T08:00:00Z'),
      },
    );

    const res = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-18',
      route: 'Pamba - Marakkoottam - 4 Kms',
    });

    expect(res.matched).toBe(true);
    expect(res.bookingId).toBe('b-10033');
    expect(res.message).toContain('recovered stale match');

    // Opportunity now points to b-10033
    const opp = mockOpportunities.find((o) => o.id === 'opp-stale');
    expect(opp.matchedBookingId).toBe('b-10033');
    expect(opp.status).toBe('MATCHED');

    // New booking transitioned to EXECUTION_QUEUED
    const b10033 = mockBookings.find((b) => b.id === 'b-10033');
    expect(b10033.status).toBe(BookingStatus.EXECUTION_QUEUED);
  });

  // REGRESSION 3: Existing opportunity matched to a failed booking can be recovered when no active job remains
  it('REGRESSION 3: Existing opportunity matched to a failed booking is recovered when jobs are terminal', async () => {
    mockOpportunities.push({
      id: 'opp-failed',
      idempotencyKey: '2026-11-19|Pamba',
      date: '2026-11-19',
      route: 'Pamba',
      timeSlot: 'DATE_ONLY',
      status: 'MATCHED',
      matchedBookingId: 'b-failed',
    });

    mockBookings.push(
      {
        id: 'b-failed',
        bookingCode: 'TA-FAILED',
        requestedDateStr: '2026-11-19',
        requestedDate: new Date('2026-11-19T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.FAILED,
        createdAt: new Date('2026-11-19T06:00:00Z'),
      },
      {
        id: 'b-next',
        bookingCode: 'TA-NEXT',
        requestedDateStr: '2026-11-19',
        requestedDate: new Date('2026-11-19T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-11-19T07:00:00Z'),
      },
    );

    mockBookingJobs.push({
      id: 'job-failed',
      bookingRequestId: 'b-failed',
      status: BookingStatus.FAILED,
    });

    const res = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-19',
      route: 'Pamba',
    });

    expect(res.matched).toBe(true);
    expect(res.bookingId).toBe('b-next');
  });

  // REGRESSION 4: Missing matched booking can be recovered only when no active claim/job exists
  it('REGRESSION 4: Missing matched booking can be recovered when no active job exists', async () => {
    mockOpportunities.push({
      id: 'opp-orphan',
      idempotencyKey: '2026-11-20|Pamba',
      date: '2026-11-20',
      route: 'Pamba',
      timeSlot: 'DATE_ONLY',
      status: 'MATCHED',
      matchedBookingId: 'b-deleted', // Does not exist in mockBookings
    });

    mockBookings.push({
      id: 'b-orphan-recover',
      bookingCode: 'TA-ORPHAN',
      requestedDateStr: '2026-11-20',
      requestedDate: new Date('2026-11-20T00:00:00Z'),
      route: 'Pamba',
      status: BookingStatus.PENDING,
      createdAt: new Date(),
    });

    const res = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-20',
      route: 'Pamba',
    });

    expect(res.matched).toBe(true);
    expect(res.bookingId).toBe('b-orphan-recover');
  });

  // REGRESSION 5: An active job prevents duplicate reassignment
  it('REGRESSION 5: An active in-flight job blocks reassignment even if booking status is CANCELLED', async () => {
    mockOpportunities.push({
      id: 'opp-active-job',
      idempotencyKey: '2026-11-21|Pamba',
      date: '2026-11-21',
      route: 'Pamba',
      timeSlot: 'DATE_ONLY',
      status: 'MATCHED',
      matchedBookingId: 'b-cancelled-busy',
    });

    mockBookings.push(
      {
        id: 'b-cancelled-busy',
        bookingCode: 'TA-BUSY',
        requestedDateStr: '2026-11-21',
        requestedDate: new Date('2026-11-21T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.CANCELLED,
        createdAt: new Date('2026-11-21T06:00:00Z'),
      },
      {
        id: 'b-waiting',
        bookingCode: 'TA-WAITING',
        requestedDateStr: '2026-11-21',
        requestedDate: new Date('2026-11-21T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-11-21T07:00:00Z'),
      },
    );

    // Active in-flight job
    mockBookingJobs.push({
      id: 'job-inflight',
      bookingRequestId: 'b-cancelled-busy',
      status: BookingStatus.EXECUTING,
      leaseExpiresAt: new Date(Date.now() + 60000),
    });

    const res = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-21',
      route: 'Pamba',
    });

    expect(res.matched).toBe(false);
    expect(res.message).toContain('active in-flight execution job');
  });

  // REGRESSION 6: Two concurrent events cannot create duplicate jobs or claim the same booking
  it('REGRESSION 6: Two concurrent events cannot create duplicate jobs or claim the same booking', async () => {
    mockBookings.push({
      id: 'b-single',
      bookingCode: 'TA-SINGLE',
      requestedDateStr: '2026-11-26',
      requestedDate: new Date('2026-11-26T00:00:00Z'),
      route: 'Pamba',
      status: BookingStatus.PENDING,
      createdAt: new Date(),
    });

    const event: AvailabilityEventPayload = {
      date: '2026-11-26',
      route: 'Pamba',
      timeSlot: 'DATE_ONLY',
    };

    // Fire two matching attempts concurrently
    const [res1, res2] = await Promise.all([
      smartMatcher.matchAvailabilityEvent(event),
      smartMatcher.matchAvailabilityEvent(event),
    ]);

    // Exactly one should succeed, the other should fail
    const matchedCount = [res1.matched, res2.matched].filter(Boolean).length;
    expect(matchedCount).toBe(1);

    // Exactly one BookingJob should be created for b-single
    const jobsForSingle = mockBookingJobs.filter((j) => j.bookingRequestId === 'b-single');
    expect(jobsForSingle.length).toBe(1);
    expect(jobsForSingle[0].status).toBe(BookingStatus.QUEUED);
  });

  // REGRESSION 7: The new booking receives exactly one correctly associated queued job
  it('REGRESSION 7: The new booking receives exactly one correctly associated queued job', async () => {
    mockBookings.push({
      id: 'b-job-check',
      bookingCode: 'TA-JOB-CHECK',
      requestedDateStr: '2026-11-27',
      requestedDate: new Date('2026-11-27T00:00:00Z'),
      route: 'Pamba',
      status: BookingStatus.PENDING,
      createdAt: new Date(),
    });

    const res = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-27',
      route: 'Pamba',
    });

    expect(res.matched).toBe(true);

    const jobs = mockBookingJobs.filter((j) => j.bookingRequestId === 'b-job-check');
    expect(jobs.length).toBe(1);
    expect(jobs[0].jobType).toBe(JobType.BOOKING_EXECUTION);
    expect(jobs[0].status).toBe(BookingStatus.QUEUED);
  });

  // REGRESSION 8: The opportunity matchedBookingId and status are consistent with the new assignment
  it('REGRESSION 8: Opportunity matchedBookingId and status are consistent with the new assignment', async () => {
    mockBookings.push({
      id: 'b-assoc',
      bookingCode: 'TA-ASSOC',
      requestedDateStr: '2026-11-28',
      requestedDate: new Date('2026-11-28T00:00:00Z'),
      route: 'Pamba',
      status: BookingStatus.PENDING,
      createdAt: new Date(),
    });

    const res = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-28',
      route: 'Pamba',
    });

    expect(res.matched).toBe(true);

    const opp = mockOpportunities.find((o) => o.idempotencyKey === '2026-11-28|Pamba');
    expect(opp).toBeDefined();
    expect(opp.status).toBe('MATCHED');
    expect(opp.matchedBookingId).toBe('b-assoc');
  });

  // REGRESSION 9: Unavailable dates and route mismatches are still rejected
  it('REGRESSION 9: Unavailable dates and route mismatches are rejected', async () => {
    mockBookings.push({
      id: 'b-pamba',
      bookingCode: 'TA-PAMBA',
      requestedDateStr: '2026-11-29',
      requestedDate: new Date('2026-11-29T00:00:00Z'),
      route: 'Pamba',
      status: BookingStatus.PENDING,
      createdAt: new Date(),
    });

    // Event with different date
    const resDate = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-30',
      route: 'Pamba',
    });
    expect(resDate.matched).toBe(false);
    expect(resDate.message).toContain('No pending bookings found');

    // Event with route mismatch
    const resRoute = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-29',
      route: 'Erumeli',
    });
    expect(resRoute.matched).toBe(false);
    expect(resRoute.message).toContain('No pending bookings found');
  });

  // REGRESSION 10: Date-only and time-slot-specific idempotency behavior both remain correct
  it('REGRESSION 10: Date-only and time-slot-specific idempotency behavior both remain correct', async () => {
    mockBookings.push(
      {
        id: 'b-date-only',
        bookingCode: 'TA-DATE-ONLY',
        requestedDateStr: '2026-11-30',
        requestedDate: new Date('2026-11-30T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-11-30T08:00:00Z'),
        accountId: 'acc-slot-1',
        account: { id: 'acc-slot-1', status: AccountStatus.VERIFIED },
      },
      {
        id: 'b-slot-specific',
        bookingCode: 'TA-SLOT-SPECIFIC',
        requestedDateStr: '2026-11-30',
        requestedDate: new Date('2026-11-30T00:00:00Z'),
        route: 'Pamba',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-11-30T08:05:00Z'),
        accountId: 'acc-slot-2',
        account: { id: 'acc-slot-2', status: AccountStatus.VERIFIED },
      },
    );

    // Fire date-only event
    const res1 = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-30',
      route: 'Pamba',
    });
    expect(res1.matched).toBe(true);
    expect(res1.bookingId).toBe('b-date-only');

    // Fire time-slot event (distinct idempotencyKey)
    const res2 = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-30',
      route: 'Pamba',
      timeSlot: '14:00-15:00',
    });
    expect(res2.matched).toBe(true);
    expect(res2.bookingId).toBe('b-slot-specific');

    // Verify two distinct opportunities exist in the database
    const oppDateOnly = mockOpportunities.find((o) => o.idempotencyKey === '2026-11-30|Pamba');
    const oppSlot = mockOpportunities.find((o) => o.idempotencyKey === '2026-11-30|Pamba|14:00-15:00');

    expect(oppDateOnly).toBeDefined();
    expect(oppDateOnly.matchedBookingId).toBe('b-date-only');
    expect(oppSlot).toBeDefined();
    expect(oppSlot.matchedBookingId).toBe('b-slot-specific');
  });

  // REGRESSION 11: Stale opportunity whose previous booking job failed with LOGIN_FAILED is recovered
  it('REGRESSION 11: Stale opportunity whose previous booking job failed with LOGIN_FAILED is recovered and matched to next eligible pending booking', async () => {
    mockOpportunities.push({
      id: 'opp-login-fail',
      idempotencyKey: '2026-11-18|Pamba - Marakkoottam - 4 Kms',
      date: '2026-11-18',
      route: 'Pamba - Marakkoottam - 4 Kms',
      timeSlot: 'DATE_ONLY',
      status: 'MATCHED',
      matchedBookingId: 'b-prev-cancelled',
    });

    mockBookings.push(
      {
        id: 'b-prev-cancelled',
        bookingCode: 'TA-10034',
        requestedDateStr: '2026-11-18',
        requestedDate: new Date('2026-11-18T00:00:00Z'),
        route: 'Pamba (Regular Footpath Route)',
        status: BookingStatus.CANCELLED,
        createdAt: new Date('2026-11-18T06:00:00Z'),
      },
      {
        id: 'b-pending-10037',
        bookingCode: 'TA-10037',
        requestedDateStr: '2026-11-18',
        requestedDate: new Date('2026-11-18T00:00:00Z'),
        route: 'Pamba (Regular Footpath Route)',
        status: BookingStatus.PENDING,
        createdAt: new Date('2026-11-18T07:00:00Z'),
        accountId: 'acc-10037',
        account: { id: 'acc-10037', status: AccountStatus.VERIFIED },
        nomineeName: 'NIJA',
      },
    );

    mockBookingJobs.push({
      id: 'job-login-failed',
      bookingRequestId: 'b-prev-cancelled',
      status: BookingStatus.LOGIN_FAILED,
      completedAt: new Date(Date.now() - 3600000),
      leaseExpiresAt: new Date(Date.now() - 1800000),
    });

    const res = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-18',
      route: 'Pamba - Marakkoottam - 4 Kms',
    });

    expect(res.matched).toBe(true);
    expect(res.bookingId).toBe('b-pending-10037');
    expect(res.message).toContain('recovered stale match');

    // Opportunity reassigned to new booking
    const opp = mockOpportunities.find((o) => o.id === 'opp-login-fail');
    expect(opp.matchedBookingId).toBe('b-pending-10037');

    // Job created for new booking
    const newJob = mockBookingJobs.find((j) => j.bookingRequestId === 'b-pending-10037');
    expect(newJob).toBeDefined();
    expect(newJob.status).toBe(BookingStatus.QUEUED);
  });

  // REGRESSION 12: Duplicate availability events while matched booking is active are safely rejected
  it('REGRESSION 12: Duplicate availability events while matched booking is active are safely rejected without creating duplicate jobs', async () => {
    mockOpportunities.push({
      id: 'opp-active',
      idempotencyKey: '2026-11-22|Pamba',
      date: '2026-11-22',
      route: 'Pamba',
      timeSlot: 'DATE_ONLY',
      status: 'MATCHED',
      matchedBookingId: 'b-active',
    });

    mockBookings.push({
      id: 'b-active',
      bookingCode: 'TA-ACTIVE',
      requestedDateStr: '2026-11-22',
      requestedDate: new Date('2026-11-22T00:00:00Z'),
      route: 'Pamba',
      status: BookingStatus.EXECUTION_QUEUED,
      createdAt: new Date(),
    });

    const jobsBefore = mockBookingJobs.length;

    const resDuplicate = await smartMatcher.matchAvailabilityEvent({
      date: '2026-11-22',
      route: 'Pamba',
    });

    expect(resDuplicate.matched).toBe(false);
    expect(resDuplicate.message).toContain('already claimed/matched by another booking');
    expect(mockBookingJobs.length).toBe(jobsBefore);
  });
});
