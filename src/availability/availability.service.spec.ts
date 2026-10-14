import { Test, TestingModule } from '@nestjs/testing';
import { AvailabilityService } from './availability.service';
import { SmartMatcherService } from './smart-matcher.service';
import { AccountLockService } from './account-lock.service';
import { PrismaService } from '../prisma/prisma.service';
import { BookingStatus } from '@prisma/client';

describe('AvailabilityService - Date Demand Index & Reconciliation', () => {
  let availabilityService: AvailabilityService;
  let smartMatcher: SmartMatcherService;
  let accountLockService: AccountLockService;

  let mockBookings: any[] = [];
  let mockOpportunities: any[] = [];

  beforeEach(async () => {
    mockBookings = [];
    mockOpportunities = [];

    const mockPrisma = {
      bookingRequest: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          return mockBookings.filter((b) => where.status?.in?.includes(b.status));
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const b = mockBookings.find((x) => x.id === where.id);
          if (b) Object.assign(b, data);
          return b;
        }),
      },
      availabilityOpportunity: {
        findMany: jest.fn().mockImplementation(() => mockOpportunities),
      },
    };

    const mockSmartMatcher = {
      matchAvailabilityEvent: jest.fn().mockResolvedValue({ matched: true, message: 'Matched' }),
    };

    const mockAccountLock = {
      cleanupExpiredLocks: jest.fn().mockResolvedValue(0),
      isLocked: jest.fn().mockResolvedValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AvailabilityService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SmartMatcherService, useValue: mockSmartMatcher },
        { provide: AccountLockService, useValue: mockAccountLock },
      ],
    }).compile();

    availabilityService = module.get<AvailabilityService>(AvailabilityService);
    smartMatcher = module.get<SmartMatcherService>(SmartMatcherService);
    accountLockService = module.get<AccountLockService>(AccountLockService);
  });

  it('TEST 1 & 9: Computes Date Demand Index without creating 100 browser instances', async () => {
    // 40 for 22 Nov
    for (let i = 0; i < 40; i++) {
      mockBookings.push({
        id: `b22-${i}`,
        requestedDate: new Date('2026-11-22T00:00:00Z'),
        requestedDateStr: '2026-11-22',
        route: 'Pamba',
        status: BookingStatus.PENDING,
      });
    }
    // 25 for 23 Nov
    for (let i = 0; i < 25; i++) {
      mockBookings.push({
        id: `b23-${i}`,
        requestedDate: new Date('2026-11-23T00:00:00Z'),
        requestedDateStr: '2026-11-23',
        route: 'Pamba',
        status: BookingStatus.PENDING,
      });
    }
    // 20 for 24 Nov
    for (let i = 0; i < 20; i++) {
      mockBookings.push({
        id: `b24-${i}`,
        requestedDate: new Date('2026-11-24T00:00:00Z'),
        requestedDateStr: '2026-11-24',
        route: 'Pamba',
        status: BookingStatus.PENDING,
      });
    }
    // 15 for 25 Nov
    for (let i = 0; i < 15; i++) {
      mockBookings.push({
        id: `b25-${i}`,
        requestedDate: new Date('2026-11-25T00:00:00Z'),
        requestedDateStr: '2026-11-25',
        route: 'Pamba',
        status: BookingStatus.PENDING,
      });
    }

    const demandGroups = await availabilityService.getDemandDates();

    expect(demandGroups).toHaveLength(4);
    expect(demandGroups[0]).toEqual({ date: '2026-11-22', route: 'Pamba', pendingCount: 40 });
    expect(demandGroups[1]).toEqual({ date: '2026-11-23', route: 'Pamba', pendingCount: 25 });
    expect(demandGroups[2]).toEqual({ date: '2026-11-24', route: 'Pamba', pendingCount: 20 });
    expect(demandGroups[3]).toEqual({ date: '2026-11-25', route: 'Pamba', pendingCount: 15 });
  });

  it('TEST 10: Unavailable date (22 Nov) keeps pending demand registered while monitoring continues', async () => {
    mockBookings.push({
      id: 'b22-long',
      requestedDate: new Date('2026-11-22T00:00:00Z'),
      requestedDateStr: '2026-11-22',
      route: 'Pamba',
      status: BookingStatus.PENDING,
    });

    const demand = await availabilityService.getDemandDates();
    expect(demand).toHaveLength(1);
    expect(demand[0].pendingCount).toBe(1);
    expect(mockBookings[0].status).toBe(BookingStatus.PENDING);
  });
});
