import { Test, TestingModule } from '@nestjs/testing';
import { BookingsService } from './bookings.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { AccountLockService } from '../availability/account-lock.service';
import { EventsGateway } from '../events/events.gateway';
import { BookingStateMachineService } from './booking-state-machine.service';
import { TicketPricingService } from '../pricing/ticket-pricing.service';
import { SmartAllocatorService } from '../workers/smart-allocator.service';
import { Role, BookingStatus } from '@prisma/client';
import { NotFoundException, ForbiddenException } from '@nestjs/common';

describe('BookingsService - deleteBooking & deleteBookings', () => {
  let service: BookingsService;

  const mockBooking = {
    id: 'b-delete-123',
    bookingCode: 'TA-DEL-001',
    userId: 'user-centre-1',
    accountId: 'acc-1',
    status: BookingStatus.PENDING,
    requestedDate: new Date('2026-12-14'),
    requestedDateStr: '2026-12-14',
    route: 'Pamba',
    assignedMachineId: 'worker-1',
    assignedMonitoringWorkerId: 'worker-1',
  };

  const mockPrisma: any = {
    bookingRequest: {
      findUnique: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    walletTransaction: {
      findMany: jest.fn().mockResolvedValue([
        { type: 'RESERVE', amount: '100', status: 'COMPLETED' },
      ]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    walletLedgerEntry: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    availabilityOpportunity: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    accountLock: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    jobAllocationLog: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookingMilestone: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookingAttempt: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookingReconciliation: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    bookingJob: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    bookingPilgrim: {
      deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    workerMachine: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
  };

  const mockWalletService = {
    release: jest.fn().mockResolvedValue(true),
  };

  const mockAudit = {
    log: jest.fn().mockResolvedValue(true),
  };

  const mockNotifications = {
    sendTelegramBookingNotification: jest.fn().mockResolvedValue(true),
  };

  const mockSmartMatcher = {};

  const mockAccountLockService = {
    releaseLock: jest.fn().mockResolvedValue(true),
  };

  const mockEventsGateway = {
    emitToAdmins: jest.fn(),
    notifyBookingUpdated: jest.fn(),
  };

  const mockStateMachine = {
    transition: jest.fn(),
  };

  const mockPricingService = {};

  const mockSmartAllocator = {
    runAllocationSweep: jest.fn().mockResolvedValue({ allocatedCount: 0, pendingCount: 0 }),
    runMonitoringAllocationSweep: jest.fn().mockResolvedValue({ allocatedCount: 0, pendingCount: 0 }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: mockWalletService },
        { provide: AuditService, useValue: mockAudit },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: SmartMatcherService, useValue: mockSmartMatcher },
        { provide: AccountLockService, useValue: mockAccountLockService },
        { provide: EventsGateway, useValue: mockEventsGateway },
        { provide: BookingStateMachineService, useValue: mockStateMachine },
        { provide: TicketPricingService, useValue: mockPricingService },
        { provide: SmartAllocatorService, useValue: mockSmartAllocator },
      ],
    }).compile();

    service = module.get<BookingsService>(BookingsService);
  });

  it('successfully deletes a booking, releases wallet hold, and unlinks records', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValueOnce(mockBooking);
    mockPrisma.bookingRequest.delete.mockResolvedValueOnce(mockBooking);

    const user = { id: 'admin-1', role: Role.SUPER_ADMIN, email: 'admin@test.com' };
    const res = await service.deleteBooking('b-delete-123', user);

    expect(res.success).toBe(true);
    expect(res.bookingCode).toBe('TA-DEL-001');

    // Wallet hold released
    expect(mockWalletService.release).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-centre-1',
        bookingId: 'b-delete-123',
        amount: 100,
      }),
    );

    // Devotee account lock released
    expect(mockAccountLockService.releaseLock).toHaveBeenCalledWith('acc-1', 'b-delete-123');

    // Worker state reset
    expect(mockPrisma.workerMachine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'worker-1', currentBookingId: 'b-delete-123' },
      }),
    );

    // Dependent records deleted
    expect(mockPrisma.bookingPilgrim.deleteMany).toHaveBeenCalledWith({ where: { bookingRequestId: 'b-delete-123' } });
    expect(mockPrisma.bookingJob.deleteMany).toHaveBeenCalledWith({ where: { bookingRequestId: 'b-delete-123' } });
    expect(mockPrisma.bookingRequest.delete).toHaveBeenCalledWith({ where: { id: 'b-delete-123' } });

    // WebSocket events emitted
    expect(mockEventsGateway.emitToAdmins).toHaveBeenCalledWith('admin:booking_deleted', expect.any(Object));

    // Allocator sweeps triggered
    expect(mockSmartAllocator.runAllocationSweep).toHaveBeenCalled();
    expect(mockSmartAllocator.runMonitoringAllocationSweep).toHaveBeenCalled();
  });

  it('throws NotFoundException if booking does not exist', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValueOnce(null);

    const user = { id: 'admin-1', role: Role.SUPER_ADMIN };
    await expect(service.deleteBooking('non-existent', user)).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException if CENTRE attempts to delete another user booking', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValueOnce(mockBooking);

    const user = { id: 'other-centre-user', role: Role.CENTRE };
    await expect(service.deleteBooking('b-delete-123', user)).rejects.toThrow(ForbiddenException);
  });

  it('bulk deletes multiple bookings', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValue(mockBooking);
    mockPrisma.bookingRequest.delete.mockResolvedValue(mockBooking);

    const user = { id: 'admin-1', role: Role.SUPER_ADMIN };
    const res = await service.deleteBookings(['b-1', 'b-2'], user);

    expect(res.success).toBe(true);
    expect(res.deletedCount).toBe(2);
  });
});
