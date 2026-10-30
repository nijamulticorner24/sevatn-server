import { Test, TestingModule } from '@nestjs/testing';
import { AccountLockService } from './account-lock.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AccountLockService - Same-Booking Idempotency & Exclusion Invariants', () => {
  let service: AccountLockService;
  let mockLocks: any[] = [];

  beforeEach(async () => {
    mockLocks = [];

    const mockPrismaService = {
      accountLock: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return mockLocks.find((l) => l.accountId === where.accountId) || null;
        }),
        findFirst: jest.fn().mockImplementation(({ where }) => {
          return (
            mockLocks.find((l) => {
              if (where.accountId && l.accountId !== where.accountId) return false;
              if (where.expiresAt?.gt && l.expiresAt <= where.expiresAt.gt) return false;
              if (where.bookingId?.not && l.bookingId === where.bookingId.not) return false;
              return true;
            }) || null
          );
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const existing = mockLocks.find((l) => l.accountId === data.accountId);
          if (existing) {
            const err = new Error('Unique constraint failed on the fields: (accountId)');
            (err as any).code = 'P2002';
            throw err;
          }
          const row = { ...data };
          mockLocks.push(row);
          return row;
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const existing = mockLocks.find((l) => l.accountId === where.accountId);
          if (existing) {
            Object.assign(existing, data);
            return existing;
          }
          throw new Error('Record not found');
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          let count = 0;
          for (const l of mockLocks) {
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
          const initialLen = mockLocks.length;
          mockLocks = mockLocks.filter((l) => {
            if (where.accountId && l.accountId !== where.accountId) return true;
            if (where.expiresAt?.lte && l.expiresAt > where.expiresAt.lte) return true;
            if (where.bookingId && l.bookingId !== where.bookingId) return true;
            if (where.workerId && l.workerId !== where.workerId) return true;
            return false;
          });
          return { count: initialLen - mockLocks.length };
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountLockService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<AccountLockService>(AccountLockService);
  });

  // TEST 1: Existing unexpired lock for the same booking permits safe lock reuse
  it('TEST 1: Existing unexpired lock for the same booking permits safe lock reuse', async () => {
    // Lock acquired by matcher with no workerId
    mockLocks.push({
      accountId: 'acc-1',
      bookingId: 'booking-101',
      workerId: null,
      lockedAt: new Date(),
      expiresAt: new Date(Date.now() + 300000),
    });

    // Worker PC-001 attempts to acquire lock for the same booking
    const result = await service.acquireLock('acc-1', 'booking-101', 'PC-001');

    expect(result).toBe(true);
    const lock = mockLocks.find((l) => l.accountId === 'acc-1');
    expect(lock).toBeDefined();
    expect(lock.bookingId).toBe('booking-101');
    expect(lock.workerId).toBe('PC-001'); // Associated claiming worker
    expect(mockLocks.length).toBe(1);
  });

  // TEST 2: Existing unexpired lock for another booking blocks the claim
  it('TEST 2: Existing unexpired lock for another booking blocks the claim', async () => {
    mockLocks.push({
      accountId: 'acc-1',
      bookingId: 'booking-101',
      workerId: 'PC-001',
      lockedAt: new Date(),
      expiresAt: new Date(Date.now() + 300000),
    });

    // Different booking tries to acquire lock on the same account
    const result = await service.acquireLock('acc-1', 'booking-102', 'PC-002');

    expect(result).toBe(false);
    // Lock ownership remains with booking-101
    const lock = mockLocks.find((l) => l.accountId === 'acc-1');
    expect(lock.bookingId).toBe('booking-101');
    expect(lock.workerId).toBe('PC-001');
  });

  // TEST 3: Expired lock follows the established recovery policy
  it('TEST 3: Expired lock is reclaimed by a new booking', async () => {
    mockLocks.push({
      accountId: 'acc-1',
      bookingId: 'booking-old',
      workerId: 'PC-OLD',
      lockedAt: new Date(Date.now() - 600000),
      expiresAt: new Date(Date.now() - 1000), // Expired 1 second ago
    });

    const result = await service.acquireLock('acc-1', 'booking-new', 'PC-NEW');

    expect(result).toBe(true);
    const lock = mockLocks.find((l) => l.accountId === 'acc-1');
    expect(lock.bookingId).toBe('booking-new');
    expect(lock.workerId).toBe('PC-NEW');
  });

  // TEST 4: Concurrent claims cannot assign the same account to different bookings
  it('TEST 4: Concurrent claims cannot assign the same account to different bookings', async () => {
    // Both try to acquire fresh lock for different bookings concurrently
    const [resA, resB] = await Promise.all([
      service.acquireLock('acc-1', 'booking-A', 'PC-A'),
      service.acquireLock('acc-1', 'booking-B', 'PC-B'),
    ]);

    // Exactly one must succeed, the other must fail
    expect([resA, resB].filter(Boolean).length).toBe(1);
    expect(mockLocks.length).toBe(1);
  });

  // TEST 5: Same-booking retries do not create duplicate lock rows
  it('TEST 5: Same-booking retries do not create duplicate lock rows', async () => {
    const res1 = await service.acquireLock('acc-1', 'booking-101');
    expect(res1).toBe(true);

    const res2 = await service.acquireLock('acc-1', 'booking-101', 'PC-001');
    expect(res2).toBe(true);

    const res3 = await service.acquireLock('acc-1', 'booking-101', 'PC-001');
    expect(res3).toBe(true);

    expect(mockLocks.length).toBe(1);
    expect(mockLocks[0].accountId).toBe('acc-1');
    expect(mockLocks[0].bookingId).toBe('booking-101');
    expect(mockLocks[0].workerId).toBe('PC-001');
  });

  // TEST 6: Worker claim succeeds when matcher already acquired lock
  it('TEST 6: Worker claim succeeds when Smart Matcher already acquired lock', async () => {
    // Matcher locks account during pre-queue match
    await service.acquireLock('acc-devotee', 'TA-10033');

    const matcherLock = mockLocks.find((l) => l.accountId === 'acc-devotee');
    expect(matcherLock).toBeDefined();
    expect(matcherLock.workerId).toBeUndefined();

    // Worker machine PC-001 claims the job
    const workerClaim = await service.acquireLock('acc-devotee', 'TA-10033', 'PC-001');

    expect(workerClaim).toBe(true);
    expect(mockLocks[0].workerId).toBe('PC-001');
  });

  // TEST 7: Failed claims do not leave inconsistent ownership
  it('TEST 7: A rejected conflicting claim leaves original lock intact', async () => {
    await service.acquireLock('acc-active', 'booking-owner', 'PC-OWNER');

    const originalExpiry = mockLocks[0].expiresAt;

    // Conflicting claim fails
    const failResult = await service.acquireLock('acc-active', 'booking-intruder', 'PC-OTHER');
    expect(failResult).toBe(false);

    // Verify original lock was not corrupted or overwritten
    expect(mockLocks[0].bookingId).toBe('booking-owner');
    expect(mockLocks[0].workerId).toBe('PC-OWNER');
    expect(mockLocks[0].expiresAt).toEqual(originalExpiry);
  });
});

