import { Test, TestingModule } from '@nestjs/testing';
import { WorkersService } from './workers.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccountLockService } from '../availability/account-lock.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { EventsGateway } from '../events/events.gateway';
import { NotFoundException, BadRequestException, ForbiddenException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { WorkerStatus, BookingStatus } from '@prisma/client';

describe('WorkersService — Fleet Management, Lifecycle Controls & Activity Logs', () => {
  let service: WorkersService;
  let prisma: any;
  let audit: any;
  let accountLock: any;
  let eventsGateway: any;

  const mockAdmin = { id: 'admin-1', email: 'admin@sevatn.in', role: 'SUPER_ADMIN' };

  beforeEach(async () => {
    prisma = {
      workerMachine: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
      workerActivityLog: {
        create: jest.fn().mockImplementation((args: any) => Promise.resolve({ id: 'log-1', ...args.data })),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      bookingJob: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
      bookingRequest: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      bookingAccount: {
        update: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
      $transaction: jest.fn((cb: any) => cb(prisma)),
    };

    audit = {
      log: jest.fn().mockResolvedValue(true),
    };

    accountLock = {
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
      releaseLockByWorker: jest.fn().mockResolvedValue(true),
    };

    eventsGateway = {
      notifyFleetUpdated: jest.fn(),
      emitToAdmins: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkersService,
        { provide: PrismaService, useValue: prisma },
        { provide: WalletService, useValue: {} },
        { provide: AuditService, useValue: audit },
        { provide: NotificationsService, useValue: { send: jest.fn() } },
        { provide: AccountLockService, useValue: accountLock },
        { provide: SmartMatcherService, useValue: { returnToPendingOnSlotLoss: jest.fn() } },
        { provide: EventsGateway, useValue: eventsGateway },
      ],
    }).compile();

    service = module.get<WorkersService>(WorkersService);
  });

  describe('1. Add and Pair a Worker (adminCreateWorker & approvePairing)', () => {
    it('should allow Super Admin to register a new worker and generate a valid pairing code', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue(null);
      prisma.workerMachine.create.mockImplementation((args: any) =>
        Promise.resolve({
          id: 'w-1',
          ...args.data,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );

      const res = await service.adminCreateWorker(
        { machineCode: 'PC-TEST-01', machineName: 'Test Worker PC' },
        mockAdmin,
      );

      expect(res.machine.machineCode).toBe('PC-TEST-01');
      expect(res.pairingCode).toMatch(/^PAIR-\d{4}$/);
      expect(res.setupInstructions.length).toBeGreaterThan(0);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ADMIN_CREATED_WORKER' }),
      );
    });

    it('should reject registration if active worker with the same machineCode already exists', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-TEST-01',
        active: true,
        adminStatus: 'ENABLED',
      });

      await expect(
        service.adminCreateWorker({ machineCode: 'PC-TEST-01', machineName: 'Duplicate' }, mockAdmin),
      ).rejects.toThrow(ConflictException);
    });

    it('should approve pairing, assign worker name, store SHA-256 verifier, and keep initial status STOPPED until authenticated connection', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-TEST-01',
        machineName: 'Worker hostname',
        pairingCode: 'PAIR-7721',
        adminStatus: 'ENABLED',
      });
      prisma.workerMachine.update.mockImplementation((args: any) =>
        Promise.resolve({
          id: 'w-1',
          machineCode: 'PC-TEST-01',
          machineName: args.data.machineName || 'Test Machine',
          ...args.data,
        }),
      );

      const res = await service.approvePairing(
        {
          pairingCode: 'PAIR-7721',
          machineCode: 'PC-TEST-01',
          machineName: 'Chennai Hub Terminal 01',
          location: 'Chennai Velachery',
        },
        mockAdmin,
      );

      expect(res.machine.status).toBe(WorkerStatus.STOPPED);
      expect(res.machine.adminStatus).toBe('ENABLED');
      expect(res.machine.desiredState).toBe('STOPPED');
      expect(res.machine.machineName).toBe('Chennai Hub Terminal 01');
      expect((res as any).machineToken).toBeUndefined(); // Never leak raw token in admin response
      expect(prisma.workerMachine.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WorkerStatus.STOPPED,
            active: true,
            pairingCode: null, // cleared to prevent replay
            lastHeartbeat: null, // clear until actual connection
            machineName: 'Chennai Hub Terminal 01',
          }),
        }),
      );
    });

    it('should reject pairing when machineCode does not match the pairing code binding', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-TEST-01',
        pairingCode: 'PAIR-7721',
        adminStatus: 'ENABLED',
      });

      await expect(
        service.approvePairing(
          { pairingCode: 'PAIR-7721', machineCode: 'PC-WRONG-CODE' },
          mockAdmin,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject pairing when machine is in REVOKED or RETIRED status', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-TEST-01',
        pairingCode: 'PAIR-7721',
        adminStatus: 'REVOKED',
      });

      await expect(
        service.approvePairing({ pairingCode: 'PAIR-7721' }, mockAdmin),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject pairing with expired or invalid pairing code', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue(null);

      await expect(
        service.approvePairing({ pairingCode: 'INVALID-CODE' }, mockAdmin),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('2. Lifecycle Controls (Enable, Disable, Pause, Resume, Monitor-Only, Drain)', () => {
    it('should enable an idle or disabled worker', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        adminStatus: 'DISABLED',
        active: false,
      });
      prisma.workerMachine.update.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        adminStatus: 'ENABLED',
        active: true,
      });

      const res = await service.enableWorker('w-1', mockAdmin);
      expect(res.machine.adminStatus).toBe('ENABLED');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'WORKER_MACHINE_ENABLED' }),
      );
    });

    it('should reject enabling a RETIRED worker without re-registration', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        adminStatus: 'RETIRED',
      });

      await expect(service.enableWorker('w-1', mockAdmin)).rejects.toThrow(BadRequestException);
    });

    it('should disable an idle worker immediately to STOPPED', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        currentJobId: null,
      });
      prisma.workerMachine.update.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        adminStatus: 'DISABLED',
        desiredState: 'STOPPED',
      });

      const res = await service.disableWorker('w-1', 'Maintenance window', mockAdmin);
      expect(res.machine.adminStatus).toBe('DISABLED');
      expect(res.machine.desiredState).toBe('STOPPED');
    });

    it('should set an active worker to STOPPING (drain) when disabled during execution', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        currentJobId: 'job-active-123',
      });
      prisma.workerMachine.update.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        adminStatus: 'DISABLED',
        desiredState: 'STOPPING',
      });

      const res = await service.disableWorker('w-1', 'Urgent drain', mockAdmin);
      expect(res.machine.desiredState).toBe('STOPPING');
      expect(res.message).toContain('draining safely');
    });

    it('should pause worker job assignments without disabling machine identity', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        adminStatus: 'ENABLED',
      });
      prisma.workerMachine.update.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        desiredState: 'PAUSED',
      });

      const res = await service.pauseWorker('w-1', 'Slot cooldown', mockAdmin);
      expect(res.machine.desiredState).toBe('PAUSED');
    });

    it('should resume paused worker to RUNNING', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        active: true,
        machineToken: 'hash123',
        adminStatus: 'ENABLED',
        desiredState: 'PAUSED',
      });
      prisma.workerMachine.update.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        desiredState: 'RUNNING',
      });

      const res = await service.resumeWorker('w-1', mockAdmin);
      expect(res.machine.desiredState).toBe('RUNNING');
    });

    it('should reject resuming a DISABLED, REVOKED, or RETIRED worker', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        active: true,
        machineToken: 'hash123',
        adminStatus: 'DISABLED',
      });

      await expect(service.resumeWorker('w-1', mockAdmin)).rejects.toThrow(ForbiddenException);
    });

    it('should set worker to MONITOR_ONLY mode', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({ id: 'w-1', machineCode: 'PC-01' });
      prisma.workerMachine.update.mockResolvedValue({ id: 'w-1', machineCode: 'PC-01', desiredState: 'MONITOR_ONLY' });

      const res = await service.setMonitorOnly('w-1', mockAdmin);
      expect(res.machine.desiredState).toBe('MONITOR_ONLY');
    });
  });

  describe('3. Revoke and Retire Worker Operations', () => {
    it('should revoke credentials, invalidate token, and release account locks', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        currentJobId: 'job-999',
      });
      prisma.workerMachine.update.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        adminStatus: 'REVOKED',
        machineToken: null,
      });

      const res = await service.revokeWorker('w-1', 'Compromised node', mockAdmin);
      expect(res.machine.adminStatus).toBe('REVOKED');
      expect(res.machine.machineToken).toBeNull();
      expect(accountLock.releaseLockByWorker).toHaveBeenCalledWith('w-1');
      expect(prisma.bookingJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-999', workerId: 'w-1' },
          data: expect.objectContaining({ status: BookingStatus.QUEUED }),
        }),
      );
    });

    it('should require a reason to revoke credentials', async () => {
      await expect(service.revokeWorker('w-1', '', mockAdmin)).rejects.toThrow(BadRequestException);
    });

    it('should retire worker from active fleet, preserve history, and set RETIRED tombstone', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        currentJobId: null,
      });
      prisma.workerMachine.update.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        adminStatus: 'RETIRED',
        active: false,
        machineToken: null,
      });

      const res = await service.retireWorker('w-1', 'Decommissioned old hardware', mockAdmin);
      expect(res.machine.adminStatus).toBe('RETIRED');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'WORKER_MACHINE_RETIRED' }),
      );
    });
  });

  describe('4. Job Claim Safeguards & Telemetry', () => {
    it('should prevent disabled worker from claiming new jobs', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        active: true,
        adminStatus: 'DISABLED',
        desiredState: 'RUNNING',
      });

      const res: any = await service.claimJob('w-1');
      expect(res.hasJob).toBe(false);
      expect(res.stopped).toBe(true);
      expect(res.message).toContain('administratively disabled');
    });

    it('should reject job claims from paused or monitor-only workers', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        active: true,
        adminStatus: 'ENABLED',
        desiredState: 'PAUSED',
      });

      const res: any = await service.claimJob('w-1');
      expect(res.hasJob).toBe(false);
      expect(res.stopped).toBe(true);
    });

    it('should reject claim from revoked or retired worker with UnauthorizedException', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        active: false,
        adminStatus: 'REVOKED',
      });

      await expect(service.claimJob('w-1')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('5. Fleet Summary & Activity Log Filtering', () => {
    it('should calculate accurate fleet summary metrics', async () => {
      const now = new Date();
      prisma.workerMachine.findMany.mockResolvedValue([
        { id: '1', active: true, adminStatus: 'ENABLED', desiredState: 'RUNNING', lastHeartbeat: now, status: 'IDLE' },
        { id: '2', active: true, adminStatus: 'ENABLED', desiredState: 'RUNNING', lastHeartbeat: now, status: 'BUSY', currentJobId: 'job-1' },
        { id: '3', active: true, adminStatus: 'DISABLED', desiredState: 'STOPPED', lastHeartbeat: now, status: 'IDLE' },
        { id: '4', active: true, adminStatus: 'ENABLED', desiredState: 'RUNNING', lastHeartbeat: new Date(now.getTime() - 100000), status: 'OFFLINE' },
      ]);
      prisma.bookingJob.count
        .mockResolvedValueOnce(5) // queuedJobsCount
        .mockResolvedValueOnce(1); // staleLeasesCount

      const summary = await service.getFleetSummary();
      expect(summary.totalWorkers).toBe(4);
      expect(summary.onlineWorkers).toBe(3);
      expect(summary.offlineWorkers).toBe(1);
      expect(summary.enabledWorkers).toBe(3);
      expect(summary.disabledWorkers).toBe(1);
      expect(summary.executingWorkers).toBe(1);
      expect(summary.queuedJobs).toBe(5);
      expect(summary.staleLeases).toBe(1);
    });

    it('should filter worker activity logs and sanitize sensitive tokens', async () => {
      prisma.workerMachine.findUnique.mockResolvedValue({
        id: 'w-1',
        machineCode: 'PC-01',
        machineName: 'Terminal 01',
      });
      prisma.workerActivityLog.findMany.mockResolvedValue([
        {
          id: 'log-1',
          workerId: 'w-1',
          eventType: 'JOB_CLAIMED',
          severity: 'INFO',
          message: 'Claimed job with token wkt_abc123456789012345678901234567890',
          timestamp: new Date(),
        },
      ]);
      prisma.workerActivityLog.count.mockResolvedValue(1);

      const res = await service.getWorkerActivityLogs('w-1', { limit: 10 });
      expect(res.logs.length).toBe(1);
      expect(res.logs[0].message).toContain('wkt_***REDACTED***');
    });
  });
});
