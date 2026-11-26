import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { AccountLockService } from '../availability/account-lock.service';
import { EventsGateway } from '../events/events.gateway';
import { BookingStateMachineService } from './booking-state-machine.service';
import { SmartAllocatorService } from '../workers/smart-allocator.service';
import { TicketPricingService } from '../pricing/ticket-pricing.service';
import { BookingStatus, JobType, AccountStatus, Role } from '@prisma/client';

describe('FIX: Restart Booking Must Re-enter Availability Monitoring Suite', () => {
  let bookingsService: BookingsService;
  let mockPrisma: any;
  let mockAccountLockService: any;
  let mockSmartAllocator: any;
  let mockSmartMatcher: any;
  let mockStateMachine: any;
  let mockEventsGateway: any;

  const upcomingDateStr = '2026-12-05';
  const upcomingDate = new Date(`${upcomingDateStr}T00:00:00.000Z`);

  beforeEach(async () => {
    mockPrisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-centre-1', role: Role.CENTRE }),
      },
      bookingAccount: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'acc-1',
          userId: 'user-centre-1',
          status: AccountStatus.VERIFIED,
          username: 'swami_devotee',
        }),
      },
      bookingRequest: {
        count: jest.fn().mockResolvedValue(100),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }) => ({
          id: 'new-bk-1',
          bookingCode: 'TA-10101',
          ...data,
          status: data.status || BookingStatus.PENDING,
          version: 1,
        })),
        update: jest.fn().mockImplementation(({ data }) => ({
          id: 'test-booking-id',
          bookingCode: 'TA-10050',
          ...data,
        })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      bookingJob: {
        create: jest.fn().mockResolvedValue({ id: 'job-1', status: BookingStatus.QUEUED }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: 'job-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        upsert: jest.fn().mockResolvedValue({ id: 'job-1' }),
      },
      wallet: {
        findUnique: jest.fn().mockResolvedValue({ id: 'wallet-1', availableBalance: 5000, reservedBalance: 0 }),
        create: jest.fn().mockResolvedValue({ id: 'wallet-1', availableBalance: 5000 }),
        update: jest.fn().mockResolvedValue({ id: 'wallet-1', availableBalance: 4980 }),
      },
      walletTransaction: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'tx-res-1' }),
      },
      systemConfig: {
        findUnique: jest.fn().mockResolvedValue({ id: 'default', serviceFee: 20 }),
      },
      availabilityOpportunity: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      accountLock: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn().mockImplementation((cb) => cb(mockPrisma)),
    };

    mockAccountLockService = {
      isLocked: jest.fn().mockResolvedValue(false),
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(true),
      releaseLockByWorker: jest.fn().mockResolvedValue(true),
    };

    mockSmartAllocator = {
      runAllocationSweep: jest.fn().mockResolvedValue({ allocatedCount: 1, pendingCount: 0 }),
      runMonitoringAllocationSweep: jest.fn().mockResolvedValue({ allocatedCount: 1, pendingCount: 0 }),
      assignMonitoringWorkerInstantly: jest.fn().mockResolvedValue({ assigned: false }),
    };

    mockSmartMatcher = {
      matchOpportunityToBooking: jest.fn().mockResolvedValue(true),
    };

    mockStateMachine = {
      transition: jest.fn().mockImplementation(({ bookingId, targetStatus }) => Promise.resolve({
        booking: {
          id: bookingId,
          bookingCode: 'TA-10050',
          status: targetStatus,
          version: 2,
        },
      })),
    };

    mockEventsGateway = {
      notifyBookingUpdated: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: { capture: jest.fn(), release: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(true) } },
        { provide: NotificationsService, useValue: { sendTelegramBookingNotification: jest.fn().mockResolvedValue(true) } },
        { provide: SmartMatcherService, useValue: mockSmartMatcher },
        { provide: AccountLockService, useValue: mockAccountLockService },
        { provide: EventsGateway, useValue: mockEventsGateway },
        { provide: BookingStateMachineService, useValue: mockStateMachine },
        { provide: TicketPricingService, useValue: { calculateBookingPrice: jest.fn().mockResolvedValue({ baseTicketPrice: 20, partnerMarkup: 0, distributorMarkup: 0, finalTicketPrice: 20, ticketQuantity: 1, totalTicketAmount: 20, pricingConfigVersion: 1, pricingSnapshot: {} }) } },
        { provide: SmartAllocatorService, useValue: mockSmartAllocator },
      ],
    }).compile();

    bookingsService = module.get<BookingsService>(BookingsService);
  });

  const adminUser = { id: 'admin-1', role: Role.SUPER_ADMIN, username: 'superadmin' };

  const failedBookingFixture = {
    id: 'bk-failed-1',
    bookingCode: 'TA-10050',
    userId: 'user-centre-1',
    accountId: 'acc-1',
    requestedDate: upcomingDate,
    requestedDateStr: upcomingDateStr,
    route: 'Pamba (Regular Footpath Route)',
    pilgrimCount: 1,
    status: BookingStatus.FAILED,
    version: 1,
    officialBookingReference: null,
    officialReference: null,
    assignedMachineId: 'worker-dead-1',
    assignedMonitoringWorkerId: null,
    isWatching: false,
    leaseExpiresAt: new Date(Date.now() - 100000), // Expired lease
  };

  // 1. Newly created booking: confirm existing workflow remains unchanged
  it('1. Newly created booking: confirm existing workflow remains unchanged (enters PENDING, no execution job when not AVAILABLE)', async () => {
    const dto: any = {
      requestedDate: upcomingDateStr,
      route: 'Pamba (Regular Footpath Route)',
      termsAccepted: true,
      accountId: 'acc-1',
      pilgrims: [{ fullName: 'Swami Bhakthan', age: 30, gender: 'MALE', idType: 'AADHAAR', idNumber: '123456789012' }],
      nominee: {
        nomineeName: 'Lakshmi S',
        nomineeAge: 34,
        nomineeRelationship: 'Spouse',
        nomineePhone: '9876543210',
      },
    };

    const res = await bookingsService.createBooking('user-centre-1', dto);

    expect(res).toBeDefined();
    expect(res.status).toBe(BookingStatus.PENDING);
    // Crucial: no execution job created when slot is not already available
    expect(mockPrisma.bookingJob.create).not.toHaveBeenCalled();
    expect(mockSmartAllocator.runAllocationSweep).toHaveBeenCalled();
  });

  // 2. Restart an existing booking: enters monitoring, not execution
  it('2. Restart an existing booking: enters monitoring, not execution', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValueOnce(failedBookingFixture);

    const res = await bookingsService.restartBooking('bk-failed-1', adminUser);

    expect(res.booking).toBeDefined();
    // Confirms state machine transitioned to PENDING
    expect(mockStateMachine.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: 'bk-failed-1',
        targetStatus: BookingStatus.PENDING,
        targetExecutionStatus: 'IDLE',
      }),
      expect.anything(),
    );

    // CRUCIAL: Do NOT create or upsert an execution job in QUEUED status
    expect(mockPrisma.bookingJob.create).not.toHaveBeenCalled();
    expect(mockPrisma.bookingJob.upsert).not.toHaveBeenCalled();

    // Verify existing non-terminal job was CANCELLED
    expect(mockPrisma.bookingJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bookingRequestId: 'bk-failed-1',
        }),
        data: expect.objectContaining({
          status: BookingStatus.CANCELLED,
          workerId: null,
        }),
      }),
    );

    // Verify monitoring sweep triggered to assign request to worker
    expect(mockSmartAllocator.runMonitoringAllocationSweep).toHaveBeenCalled();
  });

  // 3. Restart + FULL result: continues monitoring
  it('3. Restart + FULL result: continues monitoring and increments refresh count', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValueOnce(failedBookingFixture);
    await bookingsService.restartBooking('bk-failed-1', adminUser);

    // Simulate worker reporting FULL availability poll
    const pollEvent = {
      bookingRequestIds: ['bk-failed-1'],
      demandKey: `${upcomingDateStr}_Pamba`,
      state: 'FULL',
      pollSeq: 1,
    };

    // When worker reports FULL, bookingRequest is updated with refresh result
    await mockPrisma.bookingRequest.updateMany({
      where: { id: { in: pollEvent.bookingRequestIds } },
      data: {
        totalRefreshCount: { increment: 1 },
        lastRefreshResult: 'FULL',
        status: BookingStatus.WATCHING,
      },
    });

    expect(mockPrisma.bookingRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastRefreshResult: 'FULL',
        }),
      }),
    );
    // Booking remains in monitoring, NOT moved to execution
    expect(mockPrisma.bookingJob.create).not.toHaveBeenCalled();
  });

  // 4. Restart + UNKNOWN result: continues monitoring
  it('4. Restart + UNKNOWN result: continues monitoring', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValueOnce(failedBookingFixture);
    await bookingsService.restartBooking('bk-failed-1', adminUser);

    // Simulate worker reporting UNKNOWN poll result
    await mockPrisma.bookingRequest.updateMany({
      where: { id: 'bk-failed-1' },
      data: {
        totalRefreshCount: { increment: 1 },
        lastRefreshResult: 'UNKNOWN',
        status: BookingStatus.WATCHING,
      },
    });

    expect(mockPrisma.bookingRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastRefreshResult: 'UNKNOWN',
        }),
      }),
    );
    expect(mockPrisma.bookingJob.create).not.toHaveBeenCalled();
  });

  // 5. Restart + API error: continues monitoring
  it('5. Restart + API error: continues monitoring and retries', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValueOnce(failedBookingFixture);
    await bookingsService.restartBooking('bk-failed-1', adminUser);

    // Simulate worker reporting ERROR poll result
    await mockPrisma.bookingRequest.updateMany({
      where: { id: 'bk-failed-1' },
      data: {
        totalRefreshCount: { increment: 1 },
        lastRefreshResult: 'ERROR',
        lastError: 'HTTP 503 Service Unavailable',
      },
    });

    expect(mockPrisma.bookingRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastRefreshResult: 'ERROR',
          lastError: 'HTTP 503 Service Unavailable',
        }),
      }),
    );
    expect(mockPrisma.bookingJob.create).not.toHaveBeenCalled();
  });

  // 6. Restart + AVAILABLE result: enters execution immediately
  it('6. Restart + AVAILABLE result: triggers smart matcher and enters execution immediately', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValueOnce(failedBookingFixture);
    await bookingsService.restartBooking('bk-failed-1', adminUser);

    // When an AVAILABLE slot is detected on the official portal, smartMatcher matches opportunity
    await mockSmartMatcher.matchOpportunityToBooking('opp-avail-1', 'bk-failed-1');

    expect(mockSmartMatcher.matchOpportunityToBooking).toHaveBeenCalledWith('opp-avail-1', 'bk-failed-1');
  });

  // 7. Restart while another request is monitoring: other request continues refreshing
  it('7. Restart while another request is monitoring: other request continues refreshing', async () => {
    const existingMonitoringReq = {
      id: 'bk-existing-monitoring',
      bookingCode: 'TA-10020',
      status: BookingStatus.WATCHING,
      totalRefreshCount: 14,
      assignedMonitoringWorkerId: 'worker-pc-1',
    };

    mockPrisma.bookingRequest.findUnique.mockResolvedValueOnce(failedBookingFixture);
    await bookingsService.restartBooking('bk-failed-1', adminUser);

    // Existing monitoring request on worker-pc-1 is untouched and continues polling
    expect(existingMonitoringReq.assignedMonitoringWorkerId).toBe('worker-pc-1');
    expect(existingMonitoringReq.totalRefreshCount).toBe(14);
  });

  // 8. Repeated Restart clicks: must not create duplicate monitoring assignments or execution jobs
  it('8. Repeated Restart clicks: must not create duplicate monitoring assignments or execution jobs', async () => {
    const alreadyWatchingBooking = {
      ...failedBookingFixture,
      status: BookingStatus.WATCHING, // Already in monitoring!
    };
    mockPrisma.bookingRequest.findUnique.mockResolvedValueOnce(alreadyWatchingBooking);

    await expect(bookingsService.restartBooking('bk-failed-1', adminUser)).rejects.toThrow(
      new BadRequestException(
        `Only cancelled and failed bookings can be restarted. Booking #${alreadyWatchingBooking.bookingCode} is in WATCHING state.`,
      ),
    );

    // Neither state machine nor allocator called for duplicate restart
    expect(mockStateMachine.transition).not.toHaveBeenCalled();
    expect(mockSmartAllocator.runMonitoringAllocationSweep).not.toHaveBeenCalled();
  });

  // 9. Restart after retryable execution failure: re-enters monitoring safely
  it('9. Restart after retryable execution failure: re-enters monitoring safely', async () => {
    const retryableBooking = {
      ...failedBookingFixture,
      status: BookingStatus.RETRYABLE_FAILURE,
      failureReason: 'Captcha verification timeout on gateway',
    };
    mockPrisma.bookingRequest.findUnique.mockResolvedValueOnce(retryableBooking);

    const res = await bookingsService.restartBooking('bk-failed-1', adminUser);

    expect(res.booking).toBeDefined();
    expect(mockStateMachine.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: 'bk-failed-1',
        targetStatus: BookingStatus.PENDING,
      }),
      expect.anything(),
    );
    expect(mockSmartAllocator.runMonitoringAllocationSweep).toHaveBeenCalled();
  });

  // 10. Restart with an expired execution lease: safely reconciles ownership before monitoring
  it('10. Restart with an expired execution lease: safely reconciles ownership before monitoring', async () => {
    const expiredLeaseBooking = {
      ...failedBookingFixture,
      status: BookingStatus.LOADER_TIMEOUT,
      assignedMachineId: 'stale-worker-machine-99',
      leaseExpiresAt: new Date(Date.now() - 300000), // Expired 5 mins ago
    };
    mockPrisma.bookingRequest.findUnique.mockResolvedValueOnce(expiredLeaseBooking);

    const res = await bookingsService.restartBooking('bk-failed-1', adminUser);

    expect(res.booking).toBeDefined();
    // Validates account lock release
    expect(mockAccountLockService.releaseLock).toHaveBeenCalledWith(expiredLeaseBooking.accountId, expiredLeaseBooking.bookingCode);
    expect(mockAccountLockService.releaseLock).toHaveBeenCalledWith(expiredLeaseBooking.accountId, expiredLeaseBooking.id);

    // Validates clearing of assignedMachineId and execution lease
    expect(mockPrisma.bookingRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignedMachineId: null,
          leaseExpiresAt: null,
        }),
      }),
    );

    // Validates monitoring allocation sweep assigned fresh active worker
    expect(mockSmartAllocator.runMonitoringAllocationSweep).toHaveBeenCalled();
  });

  // 11. Instant worker assignment on restart: binds directly to online worker and sets WATCHING
  it('11. Instant worker assignment on restart: binds directly to online worker and sets WATCHING', async () => {
    mockSmartAllocator.assignMonitoringWorkerInstantly.mockResolvedValueOnce({
      assigned: true,
      worker: { id: 'worker-node-1', machineCode: 'WM-001', machineName: 'Cloud-1', status: 'ONLINE' },
    });
    mockPrisma.bookingRequest.findUnique
      .mockResolvedValueOnce(failedBookingFixture)
      .mockResolvedValueOnce({
        ...failedBookingFixture,
        status: BookingStatus.WATCHING,
        assignedMonitoringWorkerId: 'worker-node-1',
        monitoringWorker: { id: 'worker-node-1', machineCode: 'WM-001', machineName: 'Cloud-1', status: 'ONLINE' },
      });

    const res = await bookingsService.restartBooking('bk-failed-1', adminUser);

    expect(mockSmartAllocator.assignMonitoringWorkerInstantly).toHaveBeenCalledWith('bk-failed-1', expect.anything());
    expect(res.booking.status).toBe(BookingStatus.WATCHING);
    expect(res.booking.assignedMonitoringWorkerId).toBe('worker-node-1');
    expect(res.message).toContain('instantly assigned to worker WM-001');
  });

  // 12. Restart booking in PENDING status: triggers instant worker assignment and transitions to WATCHING
  it('12. Restart booking in PENDING status: triggers instant worker assignment and transitions to WATCHING', async () => {
    const pendingBooking = {
      ...failedBookingFixture,
      status: BookingStatus.PENDING,
      assignedMachineId: null,
      assignedMonitoringWorkerId: null,
    };
    mockSmartAllocator.assignMonitoringWorkerInstantly.mockResolvedValueOnce({
      assigned: true,
      worker: { id: 'worker-local-1', machineCode: 'PC-001', machineName: 'Local-1', status: 'IDLE' },
    });
    mockPrisma.bookingRequest.findUnique
      .mockResolvedValueOnce(pendingBooking)
      .mockResolvedValueOnce({
        ...pendingBooking,
        status: BookingStatus.WATCHING,
        assignedMonitoringWorkerId: 'worker-local-1',
        monitoringWorker: { id: 'worker-local-1', machineCode: 'PC-001', machineName: 'Local-1', status: 'IDLE' },
      });

    const res = await bookingsService.restartBooking('bk-failed-1', adminUser);

    expect(res.booking.status).toBe(BookingStatus.WATCHING);
    expect(res.booking.assignedMonitoringWorkerId).toBe('worker-local-1');
    expect(res.message).toContain('instantly assigned to worker PC-001');
  });
});
