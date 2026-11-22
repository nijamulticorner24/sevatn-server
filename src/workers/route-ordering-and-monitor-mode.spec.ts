import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { WorkersController } from './workers.controller';
import { WorkersService } from './workers.service';
import { SmartAllocatorService } from './smart-allocator.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccountLockService } from '../availability/account-lock.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { BookingStateMachineService } from '../bookings/booking-state-machine.service';
import { EventsGateway } from '../events/events.gateway';
import { MachineAuthGuard, JwtAuthGuard, RolesGuard } from '../common/guards';
import { PrismaService } from '../prisma/prisma.service';
import { BookingStatus, JobType, WorkerStatus } from '@prisma/client';
import { hashMachineToken } from '../common/security/token-hash';

describe('WorkersController Route Ordering & Monitor-Only Protection Suite (Tasks 1 & 3)', () => {
  let app: INestApplication;
  let mockWorkersService: any;
  let mockSmartAllocator: any;
  let mockPrisma: any;

  const validRawToken = 'wkt_0123456789abcdef0123456789abcdef01234567';
  const validTokenHash = hashMachineToken(validRawToken);

  beforeEach(async () => {
    mockWorkersService = {
      getPendingDates: jest.fn().mockResolvedValue({ dates: ['2026-11-23', '2026-11-24'] }),
      getWatchlist: jest.fn().mockResolvedValue([{ date: '2026-11-23', route: 'Pamba' }]),
      getWorkerById: jest.fn().mockImplementation((id: string) => Promise.resolve({ id, machineCode: 'AWS-SEVA-001' })),
      claimJob: jest.fn(),
    };

    mockSmartAllocator = {
      recoverStaleLeases: jest.fn().mockResolvedValue({ recoveredCount: 0 }),
      getAllocationHistory: jest.fn().mockResolvedValue([]),
    };

    mockPrisma = {
      workerMachine: {
        findUnique: jest.fn().mockImplementation(({ where }: any) => {
          if (where.machineToken === validTokenHash) {
            return Promise.resolve({
              id: 'wm-001',
              machineCode: 'AWS-SEVA-001',
              machineToken: validTokenHash,
              active: true,
              status: WorkerStatus.ONLINE,
              desiredState: 'RUNNING',
              maxConcurrentJobs: 1,
            });
          }
          return Promise.resolve(null);
        }),
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [WorkersController],
      providers: [
        { provide: WorkersService, useValue: mockWorkersService },
        { provide: SmartAllocatorService, useValue: mockSmartAllocator },
        { provide: PrismaService, useValue: mockPrisma },
        MachineAuthGuard,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          const auth = req.headers['authorization'];
          if (auth === 'Bearer admin_valid_jwt') {
            req.user = { id: 'admin-1', role: 'SUPER_ADMIN' };
            return true;
          }
          return false;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('1. Route Ordering & Interception Prevention', () => {
    it('GET /workers/pending-dates reaches getPendingDates() with MachineAuthGuard and is NOT intercepted by :id', async () => {
      const res = await request(app.getHttpServer())
        .get('/workers/pending-dates')
        .set('x-machine-token', validRawToken);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ dates: ['2026-11-23', '2026-11-24'] });
      expect(mockWorkersService.getPendingDates).toHaveBeenCalledTimes(1);
      expect(mockWorkersService.getWorkerById).not.toHaveBeenCalled();
    });

    it('GET /workers/watchlist reaches getWatchlist() and is NOT intercepted by :id', async () => {
      const res = await request(app.getHttpServer())
        .get('/workers/watchlist')
        .set('Authorization', 'Bearer admin_valid_jwt');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ date: '2026-11-23', route: 'Pamba' }]);
      expect(mockWorkersService.getWatchlist).toHaveBeenCalledTimes(1);
      expect(mockWorkersService.getWorkerById).not.toHaveBeenCalled();
    });

    it('GET /workers/:id matches genuine worker IDs properly', async () => {
      const res = await request(app.getHttpServer())
        .get('/workers/wm-001')
        .set('Authorization', 'Bearer admin_valid_jwt');

      expect(res.status).toBe(200);
      expect(mockWorkersService.getWorkerById).toHaveBeenCalledWith('wm-001');
    });

    it('GET /workers/pending-dates rejects missing machine token with 401 via MachineAuthGuard', async () => {
      const res = await request(app.getHttpServer())
        .get('/workers/pending-dates');

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/Worker machine token missing in x-machine-token or Authorization header/);
    });
  });

  describe('2. Monitor-Only Mode & Job Claim Safeguards', () => {
    let service: WorkersService;
    let livePrisma: any;

    beforeEach(async () => {
      const staleBookingJob = {
        id: 'job-stale-001',
        workerId: 'wm-001',
        status: BookingStatus.EXECUTING,
        jobType: JobType.BOOKING_EXECUTION,
        startedAt: new Date(Date.now() - 60000),
        leaseExpiresAt: new Date(Date.now() + 10000),
        bookingRequestId: 'br-10004',
        bookingRequest: {
          id: 'br-10004',
          bookingCode: 'TA-10004',
          status: BookingStatus.EXECUTING,
          requestedDateStr: '2026-11-23',
          route: 'Pamba (Regular Footpath Route)',
        },
      };

      livePrisma = {
        workerMachine: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'wm-001',
            machineCode: 'AWS-SEVA-001',
            active: true,
            status: WorkerStatus.ONLINE,
            desiredState: 'RUNNING',
            maxConcurrentJobs: 1,
          }),
          update: jest.fn().mockResolvedValue({}),
        },
        bookingJob: {
          findFirst: jest.fn().mockResolvedValue(staleBookingJob),
          findMany: jest.fn().mockResolvedValue([]),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue({}),
          findUnique: jest.fn().mockResolvedValue(staleBookingJob),
        },
        bookingRequest: {
          update: jest.fn().mockResolvedValue({}),
        },
        activityLog: {
          create: jest.fn().mockResolvedValue({}),
        },
        workerActivityLog: {
          create: jest.fn().mockResolvedValue({}),
        },
        $transaction: jest.fn().mockImplementation((cb) => cb(livePrisma)),
      };

      const testModule = await Test.createTestingModule({
        providers: [
          WorkersService,
          { provide: PrismaService, useValue: livePrisma },
          { provide: WalletService, useValue: { capture: jest.fn(), release: jest.fn() } },
          { provide: AuditService, useValue: { log: jest.fn() } },
          { provide: NotificationsService, useValue: { send: jest.fn() } },
          { provide: AccountLockService, useValue: { isLocked: jest.fn().mockResolvedValue(false) } },
          { provide: SmartMatcherService, useValue: { matchAvailabilityEvent: jest.fn() } },
          { provide: BookingStateMachineService, useValue: { transition: jest.fn() } },
          { provide: SmartAllocatorService, useValue: {} },
          { provide: EventsGateway, useValue: {} },
        ],
      }).compile();

      service = testModule.get<WorkersService>(WorkersService);
    });

    it('prohibits monitor-only worker (maxActiveBookings=0) from taking over or renewing booking execution leases', async () => {
      const result = await service.claimJob('wm-001', [], {
        triggerSource: 'QUEUE_POLL',
        maxActiveBookings: 0,
      });

      // Must NOT take over the stale booking job!
      expect(result.hasJob).toBe(false);
      expect(result.reason).toBe('BOOKING_EXECUTION_UNAUTHORIZED_OR_RESTRICTED');
      // Must NOT have updated the bookingJob lease or status
      expect(livePrisma.bookingJob.updateMany).not.toHaveBeenCalled();
    });

    it('prohibits worker polling for ACCOUNT_VERIFICATION from claiming pre-allocated BOOKING_EXECUTION jobs', async () => {
      const result = await service.claimJob('wm-001', [], {
        triggerSource: 'QUEUE_POLL',
        jobType: JobType.ACCOUNT_VERIFICATION,
        maxActiveBookings: 0,
      });

      expect(result.hasJob).toBe(false);
      expect(livePrisma.bookingJob.updateMany).not.toHaveBeenCalled();
    });

    it('prohibits worker from claiming or renewing booking leases when maxConcurrentJobs=0 in database (even without claimOptions)', async () => {
      livePrisma.workerMachine.findUnique.mockResolvedValueOnce({
        id: 'wm-001',
        machineCode: 'AWS-SEVA-001',
        active: true,
        status: WorkerStatus.ONLINE,
        desiredState: 'RUNNING',
        maxConcurrentJobs: 0, // Trusted backend DB configuration
      });

      const result = await service.claimJob('wm-001', []);

      expect(result.hasJob).toBe(false);
      expect(result.reason).toMatch(/MAX_CAPACITY|MONITOR_ONLY/);
      expect(livePrisma.bookingJob.updateMany).not.toHaveBeenCalled();
    });

    it('prohibits worker from claiming or renewing booking leases when desiredState=MONITOR_ONLY in database', async () => {
      livePrisma.workerMachine.findUnique.mockResolvedValueOnce({
        id: 'wm-001',
        machineCode: 'AWS-SEVA-001',
        active: true,
        status: WorkerStatus.ONLINE,
        desiredState: 'MONITOR_ONLY', // Trusted backend DB configuration
        maxConcurrentJobs: 1,
      });

      const result = await service.claimJob('wm-001', []);

      expect(result.hasJob).toBe(false);
      expect(result.stopped).toBe(true);
      expect(result.desiredState).toBe('MONITOR_ONLY');
      expect(livePrisma.bookingJob.updateMany).not.toHaveBeenCalled();
    });

    it('prohibits worker from claiming or renewing booking leases when capabilities lacks BOOKING_EXECUTION in database', async () => {
      livePrisma.workerMachine.findUnique.mockResolvedValueOnce({
        id: 'wm-001',
        machineCode: 'AWS-SEVA-001',
        active: true,
        status: WorkerStatus.ONLINE,
        desiredState: 'RUNNING',
        maxConcurrentJobs: 1,
        capabilities: ['AVAILABILITY_DISCOVERY', 'ACCOUNT_VERIFICATION'], // No BOOKING_EXECUTION
      });

      const result = await service.claimJob('wm-001', []);

      expect(result.hasJob).toBe(false);
      expect(result.reason).toMatch(/MAX_CAPACITY|MONITOR_ONLY|UNAUTHORIZED/);
      expect(livePrisma.bookingJob.updateMany).not.toHaveBeenCalled();
    });

    it('fails closed when capabilities is empty array [] in database', async () => {
      livePrisma.workerMachine.findUnique.mockResolvedValueOnce({
        id: 'wm-001',
        machineCode: 'AWS-SEVA-001',
        active: true,
        status: WorkerStatus.ONLINE,
        desiredState: 'RUNNING',
        maxConcurrentJobs: 1,
        capabilities: [], // Empty capabilities fails closed!
      });

      const result = await service.claimJob('wm-001', []);

      expect(result.hasJob).toBe(false);
      expect(result.reason).toMatch(/MAX_CAPACITY|MONITOR_ONLY|UNAUTHORIZED/);
      expect(livePrisma.bookingJob.updateMany).not.toHaveBeenCalled();
    });

    it('fails closed when capabilities is missing or null in database', async () => {
      livePrisma.workerMachine.findUnique.mockResolvedValueOnce({
        id: 'wm-001',
        machineCode: 'AWS-SEVA-001',
        active: true,
        status: WorkerStatus.ONLINE,
        desiredState: 'RUNNING',
        maxConcurrentJobs: 1,
        capabilities: null, // Null/missing capabilities fails closed!
      });

      const result = await service.claimJob('wm-001', []);

      expect(result.hasJob).toBe(false);
      expect(result.reason).toMatch(/MAX_CAPACITY|MONITOR_ONLY|UNAUTHORIZED/);
      expect(livePrisma.bookingJob.updateMany).not.toHaveBeenCalled();
    });

    it('worker-supplied payload cannot override backend database authorization', async () => {
      // Database says machine has NO booking capability
      livePrisma.workerMachine.findUnique.mockResolvedValueOnce({
        id: 'wm-001',
        machineCode: 'AWS-SEVA-001',
        active: true,
        status: WorkerStatus.ONLINE,
        desiredState: 'RUNNING',
        maxConcurrentJobs: 1,
        capabilities: ['AVAILABILITY_DISCOVERY'],
      });

      // Worker sends payload pretending to want 10 concurrent booking executions
      const result = await service.claimJob('wm-001', [], {
        triggerSource: 'QUEUE_POLL',
        jobType: 'BOOKING_EXECUTION',
        maxActiveBookings: 10,
      });

      // Backend fails closed regardless of worker claims
      expect(result.hasJob).toBe(false);
      expect(result.reason).toMatch(/MAX_CAPACITY|MONITOR_ONLY|UNAUTHORIZED/);
      expect(livePrisma.bookingJob.updateMany).not.toHaveBeenCalled();
    });

    it('prohibits unauthorized worker from renewing booking leases via renewLease', async () => {
      livePrisma.workerMachine.findUnique.mockResolvedValueOnce({
        id: 'wm-001',
        machineCode: 'AWS-SEVA-001',
        active: true,
        status: WorkerStatus.ONLINE,
        desiredState: 'RUNNING',
        maxConcurrentJobs: 0,
        capabilities: ['AVAILABILITY_DISCOVERY'],
      });

      await expect(service.renewLease('br-10004', 'wm-001')).rejects.toThrow(
        /not authorized for booking execution lease renewal/
      );
    });

    it('prohibits unauthorized worker from matching pending bookings via matchPendingBooking', async () => {
      livePrisma.workerMachine.findUnique.mockResolvedValueOnce({
        id: 'wm-001',
        machineCode: 'AWS-SEVA-001',
        active: true,
        status: WorkerStatus.ONLINE,
        desiredState: 'RUNNING',
        maxConcurrentJobs: 0,
        capabilities: ['AVAILABILITY_DISCOVERY'],
      });

      const result = await service.matchPendingBooking('wm-001', '2026-11-23', 'Pamba');
      expect(result.hasJob).toBe(false);
      expect(result.reason).toBe('BOOKING_EXECUTION_UNAUTHORIZED');
    });

    it('prohibits claiming pre-allocated booking job when worker has no BOOKING_EXECUTION capability, without modifying lease', async () => {
      livePrisma.workerMachine.findUnique.mockResolvedValueOnce({
        id: 'wm-001',
        machineCode: 'AWS-SEVA-001',
        active: true,
        status: WorkerStatus.ONLINE,
        desiredState: 'RUNNING',
        maxConcurrentJobs: 1,
        capabilities: ['AVAILABILITY_DISCOVERY', 'ACCOUNT_VERIFICATION'], // Explicitly no BOOKING_EXECUTION
      });

      const result = await service.claimJob('wm-001', []);

      expect(result.hasJob).toBe(false);
      expect(result.reason).toBe('BOOKING_EXECUTION_UNAUTHORIZED_OR_RESTRICTED');
      expect(livePrisma.bookingJob.updateMany).not.toHaveBeenCalled();
    });

    it('preserves account verification functionality for monitor-only worker with ACCOUNT_VERIFICATION capability', async () => {
      livePrisma.workerMachine.findUnique.mockResolvedValueOnce({
        id: 'wm-001',
        machineCode: 'AWS-SEVA-001',
        active: true,
        status: WorkerStatus.ONLINE,
        desiredState: 'RUNNING',
        maxConcurrentJobs: 1,
        capabilities: ['AVAILABILITY_DISCOVERY', 'ACCOUNT_VERIFICATION'],
      });

      // No pre-allocated job
      livePrisma.bookingJob.findFirst.mockResolvedValueOnce(null); // pre-allocated check
      // Transaction finds queued account verification job
      const verifJob = {
        id: 'verif-job-1',
        jobType: JobType.ACCOUNT_VERIFICATION,
        status: BookingStatus.QUEUED,
        accountId: 'acc-1',
        account: {
          id: 'acc-1',
          username: '9876543210',
          encryptedPassword: 'enc',
          encryptionIv: 'iv',
          encryptionTag: 'tag',
        },
      };
      livePrisma.bookingJob.findFirst.mockResolvedValueOnce(verifJob);
      livePrisma.bookingJob.updateMany.mockResolvedValueOnce({ count: 1 });

      const result = await service.claimJob('wm-001', [], {
        triggerSource: 'QUEUE_POLL',
        jobType: JobType.ACCOUNT_VERIFICATION,
        maxActiveBookings: 0,
      });

      expect(result.hasJob).toBe(true);
      expect(result.jobType).toBe(JobType.ACCOUNT_VERIFICATION);
      expect(result.job?.username).toBe('9876543210');
      expect(livePrisma.bookingJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'verif-job-1',
            status: BookingStatus.QUEUED,
          }),
        })
      );
    });

    it('denies account verification when capabilities lacks ACCOUNT_VERIFICATION', async () => {
      livePrisma.workerMachine.findUnique.mockResolvedValueOnce({
        id: 'wm-001',
        machineCode: 'AWS-SEVA-001',
        active: true,
        status: WorkerStatus.ONLINE,
        desiredState: 'RUNNING',
        maxConcurrentJobs: 1,
        capabilities: ['AVAILABILITY_DISCOVERY'], // No ACCOUNT_VERIFICATION
      });

      livePrisma.bookingJob.findFirst.mockResolvedValueOnce(null);

      const result = await service.claimJob('wm-001', [], {
        triggerSource: 'QUEUE_POLL',
        jobType: JobType.ACCOUNT_VERIFICATION,
        maxActiveBookings: 0,
      });

      expect(result.hasJob).toBe(false);
      expect(livePrisma.bookingJob.updateMany).not.toHaveBeenCalled();
    });
  });
});

