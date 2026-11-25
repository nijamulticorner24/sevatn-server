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

describe('WorkersService Date & Route Claim Matching Specification Suite', () => {
  let workersService: WorkersService;
  let prisma: any;

  const mockMachine = {
    id: 'worker-local-1',
    machineCode: 'WM-LOCAL-1',
    active: true,
    adminStatus: 'ENABLED',
    desiredState: 'RUNNING',
    capabilities: ['BOOKING_EXECUTION'],
    maxConcurrentJobs: 2,
    currentActiveJobs: 0,
    status: WorkerStatus.IDLE,
  };

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn().mockImplementation(async (cb) => cb(prisma)),
      workerMachine: {
        findUnique: jest.fn().mockResolvedValue(mockMachine),
        update: jest.fn().mockResolvedValue(mockMachine),
      },
      bookingJob: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'job-1', ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'job-new-1', ...data })),
      },
      bookingRequest: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'br-1', ...data })),
      },
      bookingAttempt: {
        create: jest.fn().mockResolvedValue({ id: 'att-1' }),
      },
      workerActivityLog: {
        create: jest.fn().mockResolvedValue({ id: 'act-1' }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkersService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: { getBalance: jest.fn() } },
        { provide: AccountLockService, useValue: { acquireLock: jest.fn().mockResolvedValue(true), isLocked: jest.fn().mockResolvedValue(false) } },
        { provide: SmartMatcherService, useValue: { returnToPendingOnSlotLoss: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: NotificationsService, useValue: { send: jest.fn() } },
        { provide: BookingStateMachineService, useValue: { canTransition: jest.fn().mockReturnValue(true), transition: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    workersService = module.get<WorkersService>(WorkersService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // TEST 1: Claim with matching date and route succeeds
  it('1. claimJob with matching date and route succeeds', async () => {
    const matchingCandidateJob = {
      id: 'job-matching-28',
      jobType: JobType.BOOKING_EXECUTION,
      status: BookingStatus.PENDING,
      workerId: null,
      attempt: 0,
      leaseGeneration: 0,
      bookingRequest: {
        id: 'br-matching-28',
        bookingCode: 'TA-10028',
        requestedDateStr: '2026-11-28',
        requestedDate: new Date('2026-11-28'),
        route: 'Pamba (Regular Footpath Route)',
        status: BookingStatus.PENDING,
        nextCheckAt: null,
        pilgrimCount: 1,
        pilgrims: [{ fullName: 'Devotee One' }],
        nomineeName: 'Nominee One',
        nomineeAge: 40,
        nomineeRelationship: 'BROTHER',
        nomineePhone: '9876543210',
        account: { id: 'acc-1', username: 'acc1', encryptedPassword: 'p', encryptionIv: 'iv', encryptionTag: 't' },
      },
    };

    prisma.bookingJob.findMany.mockResolvedValue([matchingCandidateJob]);

    const result = await workersService.claimJob('worker-local-1', [], {
      triggerSource: 'SLOT_OPENED',
      date: '2026-11-28',
      route: 'Pamba (Regular Footpath Route)',
    });

    expect(result.hasJob).toBe(true);
    expect(result.job?.requestedDate).toBe('2026-11-28');
    expect(result.job?.bookingCode).toBe('TA-10028');
  });

  // TEST 2: claimJob rejects candidate with mismatched date
  it('2. claimJob rejects candidate with mismatched date', async () => {
    const mismatchedCandidateJob = {
      id: 'job-mismatched-06',
      jobType: JobType.BOOKING_EXECUTION,
      status: BookingStatus.PENDING,
      workerId: null,
      attempt: 0,
      leaseGeneration: 0,
      bookingRequest: {
        id: 'br-mismatched-06',
        bookingCode: 'TA-10006',
        requestedDateStr: '2027-01-06', // Mismatched date!
        requestedDate: new Date('2027-01-06'),
        route: 'Pamba (Regular Footpath Route)',
        status: BookingStatus.PENDING,
        nextCheckAt: null,
        pilgrimCount: 1,
        pilgrims: [{ fullName: 'Devotee Six' }],
        nomineeName: 'Nominee Six',
        nomineeAge: 30,
        nomineeRelationship: 'FATHER',
        nomineePhone: '9876543210',
        account: { id: 'acc-1', username: 'acc1', encryptedPassword: 'p', encryptionIv: 'iv', encryptionTag: 't' },
      },
    };

    prisma.bookingJob.findMany.mockResolvedValue([mismatchedCandidateJob]);

    const result = await workersService.claimJob('worker-local-1', [], {
      triggerSource: 'SLOT_OPENED',
      date: '2026-11-24',
      route: 'Pamba (Regular Footpath Route)',
    });

    // Must be rejected due to date mismatch
    expect(result.hasJob).toBe(false);
    expect(result.reason).toContain('DATE_MISMATCH');
  });

  // TEST 3: Pre-allocated candidate with mismatched date is not accepted
  it('3. Pre-allocated candidate with mismatched date is not accepted when date is requested', async () => {
    const preAllocatedJobDifferentDate = {
      id: 'job-prealloc-diff',
      jobType: JobType.BOOKING_EXECUTION,
      status: BookingStatus.WORKER_ASSIGNED,
      workerId: 'worker-local-1',
      attempt: 0,
      leaseGeneration: 1,
      bookingRequest: {
        id: 'br-prealloc-diff',
        bookingCode: 'TA-10006',
        requestedDateStr: '2027-01-06', // Jan 6
        requestedDate: new Date('2027-01-06'),
        route: 'Pamba (Regular Footpath Route)',
        status: BookingStatus.WORKER_ASSIGNED,
        nextCheckAt: null,
        pilgrimCount: 1,
        pilgrims: [{ fullName: 'Devotee' }],
        nomineeName: 'Nominee',
        nomineeAge: 30,
        nomineeRelationship: 'FRIEND',
        nomineePhone: '9876543210',
        account: { id: 'acc-1', username: 'acc1', encryptedPassword: 'p', encryptionIv: 'iv', encryptionTag: 't' },
      },
    };

    // findFirst returns the preAllocatedJob (e.g. from an earlier assignment)
    prisma.bookingJob.findFirst.mockResolvedValue(preAllocatedJobDifferentDate);
    // findMany returns empty
    prisma.bookingJob.findMany.mockResolvedValue([]);

    const result = await workersService.claimJob('worker-local-1', [], {
      triggerSource: 'SLOT_OPENED',
      date: '2026-11-24',
      route: 'Pamba (Regular Footpath Route)',
    });

    // Must not accept the pre-allocated job because date is 2027-01-06, not 2026-11-24
    expect(result.hasJob).toBe(false);
  });
});
