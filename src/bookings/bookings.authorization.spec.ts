import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SmartMatcherService } from '../availability/smart-matcher.service';
import { AccountLockService } from '../availability/account-lock.service';
import { EventsGateway } from '../events/events.gateway';
import { Role, BookingStatus } from '@prisma/client';

describe('Phase 2B: Tenant Scoping & Role-Based Authorization Suite', () => {
  let bookingsService: BookingsService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      bookingRequest: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      bookingJob: {
        updateMany: jest.fn(),
        create: jest.fn(),
      },
      walletTransaction: {
        findFirst: jest.fn(),
      },
      wallet: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation((cb) => cb(mockPrisma)),
    };

    const mockWallet = {
      capture: jest.fn(),
      release: jest.fn(),
    };

    const mockAudit = {
      log: jest.fn(),
    };

    const mockEventsGateway = {
      notifyBookingUpdated: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WalletService, useValue: mockWallet },
        { provide: AuditService, useValue: mockAudit },
        { provide: NotificationsService, useValue: {} },
        { provide: SmartMatcherService, useValue: {} },
        { provide: AccountLockService, useValue: {} },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    bookingsService = module.get<BookingsService>(BookingsService);
  });

  const centreUserA = { id: 'user-centre-a', role: Role.CENTRE };
  const centreUserB = { id: 'user-centre-b', role: Role.CENTRE };
  const partnerFranchise1 = { id: 'user-partner-1', role: Role.PARTNER, partnerId: 'pt-1' };
  const partnerFranchise2 = { id: 'user-partner-2', role: Role.PARTNER, partnerId: 'pt-2' };
  const superAdmin = { id: 'admin-super', role: Role.SUPER_ADMIN };

  const bookingCentreA = {
    id: 'bk-1',
    bookingCode: 'TA-10001',
    userId: 'user-centre-a',
    status: BookingStatus.REQUIRES_HUMAN,
    user: { id: 'user-centre-a', partnerId: 'pt-1' },
  };

  it('prohibits Centre B from viewing Centre A booking details', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValue(bookingCentreA);

    await expect(bookingsService.getBookingById('bk-1', centreUserB)).rejects.toThrow(
      new ForbiddenException('Access denied to other centres booking data')
    );
  });

  it('prohibits Partner Franchise 2 from viewing bookings under Franchise 1', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValue(bookingCentreA);

    await expect(bookingsService.getBookingById('bk-1', partnerFranchise2)).rejects.toThrow(
      new ForbiddenException('Access denied to bookings outside your authorized partner franchise')
    );
  });

  it('prohibits Partner Franchise 2 from cancelling bookings under Franchise 1', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValue(bookingCentreA);

    await expect(bookingsService.cancelBooking('bk-1', partnerFranchise2)).rejects.toThrow(
      new ForbiddenException('Access denied to bookings outside your authorized partner franchise')
    );
  });

  it('prohibits Partner Franchise 2 from manually resolving bookings under Franchise 1', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValue(bookingCentreA);

    await expect(
      bookingsService.resolveHumanAction(
        'bk-1',
        { action: 'SUCCESS_CONFIRMED', officialReference: 'KL-2026-999999' },
        partnerFranchise2
      )
    ).rejects.toThrow(
      new ForbiddenException('Access denied to bookings outside your authorized partner franchise')
    );
  });

  it('rejects manual confirmation with synthetic or mock reference (SAB-2026-)', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValue(bookingCentreA);

    await expect(
      bookingsService.resolveHumanAction(
        'bk-1',
        { action: 'SUCCESS_CONFIRMED', officialReference: 'SAB-2026-MOCK-123' },
        centreUserA
      )
    ).rejects.toThrow(BadRequestException);
  });

  it('allows authorized Partner Franchise 1 to access bookings under their centres', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValue(bookingCentreA);

    const result = await bookingsService.getBookingById('bk-1', partnerFranchise1);
    expect(result.id).toBe('bk-1');
  });

  it('allows Super Admin full access to view any booking across the network', async () => {
    mockPrisma.bookingRequest.findUnique.mockResolvedValue(bookingCentreA);

    const result = await bookingsService.getBookingById('bk-1', superAdmin);
    expect(result.id).toBe('bk-1');
  });
});
