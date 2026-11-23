import { Test, TestingModule } from '@nestjs/testing';
import { TicketPricingService } from './ticket-pricing.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

describe('TicketPricingService - Three-Level Markup Engine', () => {
  let service: TicketPricingService;
  let prisma: any;

  const mockPricingConfig = {
    id: 'default',
    baseTicketPrice: new Prisma.Decimal(10.0),
    maxPartnerMarkup: new Prisma.Decimal(2.0),
    maxDistributorMarkup: new Prisma.Decimal(2.0),
    isActive: true,
    version: 1,
  };

  beforeEach(async () => {
    prisma = {
      pricingConfig: {
        findUnique: jest.fn().mockResolvedValue(mockPricingConfig),
        create: jest.fn().mockResolvedValue(mockPricingConfig),
        update: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            ...mockPricingConfig,
            ...data,
            version: mockPricingConfig.version + 1,
          }),
        ),
      },
      pricingAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'log-1' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      partner: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      distributor: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TicketPricingService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<TicketPricingService>(TicketPricingService);
  });

  describe('Pricing Calculations & Formula Invariants', () => {
    it('Case 1: Base 🪙 10 + Partner 🪙 0 + Distributor 🪙 0 = Final 🪙 10', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-centre-1',
        partner: { id: 'p-1', markup: new Prisma.Decimal(0) },
        distributor: { id: 'd-1', markup: new Prisma.Decimal(0) },
      });

      const result = await service.calculateBookingPrice({
        userId: 'user-centre-1',
        quantity: 1,
      });

      expect(result.baseTicketPrice).toBe(10);
      expect(result.partnerMarkup).toBe(0);
      expect(result.distributorMarkup).toBe(0);
      expect(result.finalTicketPrice).toBe(10);
      expect(result.totalTicketAmount).toBe(10);
    });

    it('Case 2: Base 🪙 10 + Partner 🪙 1 + Distributor 🪙 0 = Final 🪙 11', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-centre-2',
        partner: { id: 'p-1', markup: new Prisma.Decimal(1) },
        distributor: { id: 'd-1', markup: new Prisma.Decimal(0) },
      });

      const result = await service.calculateBookingPrice({
        userId: 'user-centre-2',
        quantity: 1,
      });

      expect(result.baseTicketPrice).toBe(10);
      expect(result.partnerMarkup).toBe(1);
      expect(result.distributorMarkup).toBe(0);
      expect(result.finalTicketPrice).toBe(11);
      expect(result.totalTicketAmount).toBe(11);
    });

    it('Case 3: Base 🪙 10 + Partner 🪙 2 + Distributor 🪙 1 = Final 🪙 13', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-centre-3',
        partner: { id: 'p-1', markup: new Prisma.Decimal(2) },
        distributor: { id: 'd-1', markup: new Prisma.Decimal(1) },
      });

      const result = await service.calculateBookingPrice({
        userId: 'user-centre-3',
        quantity: 1,
      });

      expect(result.baseTicketPrice).toBe(10);
      expect(result.partnerMarkup).toBe(2);
      expect(result.distributorMarkup).toBe(1);
      expect(result.finalTicketPrice).toBe(13);
      expect(result.totalTicketAmount).toBe(13);
    });

    it('Case 4: Base 🪙 10 + Partner 🪙 2 + Distributor 🪙 2 = Final 🪙 14', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-centre-4',
        partner: { id: 'p-1', markup: new Prisma.Decimal(2) },
        distributor: { id: 'd-1', markup: new Prisma.Decimal(2) },
      });

      const result = await service.calculateBookingPrice({
        userId: 'user-centre-4',
        quantity: 1,
      });

      expect(result.baseTicketPrice).toBe(10);
      expect(result.partnerMarkup).toBe(2);
      expect(result.distributorMarkup).toBe(2);
      expect(result.finalTicketPrice).toBe(14);
      expect(result.totalTicketAmount).toBe(14);
    });

    it('Quantity Multiplication: Quantity 3 at 🪙 14 produces 🪙 42 total', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-centre-mult',
        partner: { id: 'p-1', markup: new Prisma.Decimal(2) },
        distributor: { id: 'd-1', markup: new Prisma.Decimal(2) },
      });

      const result = await service.calculateBookingPrice({
        userId: 'user-centre-mult',
        quantity: 3,
      });

      expect(result.finalTicketPrice).toBe(14);
      expect(result.ticketQuantity).toBe(3);
      expect(result.totalTicketAmount).toBe(42);
    });

    it('Immutable Snapshot contains all required breakdown fields', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-centre-snap',
        partner: { id: 'p-10', markup: new Prisma.Decimal(1) },
        distributor: { id: 'd-20', markup: new Prisma.Decimal(2) },
      });

      const result = await service.calculateBookingPrice({
        userId: 'user-centre-snap',
        quantity: 2,
      });

      expect(result.pricingSnapshot).toBeDefined();
      expect(result.pricingSnapshot.baseTicketPrice).toBe(10);
      expect(result.pricingSnapshot.partnerMarkup).toBe(1);
      expect(result.pricingSnapshot.distributorMarkup).toBe(2);
      expect(result.pricingSnapshot.finalTicketPrice).toBe(13);
      expect(result.pricingSnapshot.ticketQuantity).toBe(2);
      expect(result.pricingSnapshot.totalTicketAmount).toBe(26);
      expect(result.pricingSnapshot.partnerId).toBe('p-10');
      expect(result.pricingSnapshot.distributorId).toBe('d-20');
      expect(result.pricingSnapshot.calculatedAt).toBeDefined();
    });
  });

  describe('Markup Boundary & Limit Enforcement', () => {
    it('Partner markup above 🪙 2 is strictly rejected', async () => {
      prisma.partner.findUnique.mockResolvedValue({
        id: 'p-1',
        markup: new Prisma.Decimal(0),
      });

      await expect(
        service.updatePartnerMarkup('p-1', { markup: 3 }, { id: 'user-p1', role: 'PARTNER' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('Partner negative markup is strictly rejected', async () => {
      await expect(
        service.updatePartnerMarkup('p-1', { markup: -1 }, { id: 'user-p1', role: 'PARTNER' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('Distributor markup above 🪙 2 is strictly rejected', async () => {
      prisma.distributor.findUnique.mockResolvedValue({
        id: 'd-1',
        markup: new Prisma.Decimal(0),
        partner: { markup: new Prisma.Decimal(1) },
      });

      await expect(
        service.updateDistributorMarkup('d-1', { markup: 2.5 }, { id: 'user-d1', role: 'DISTRIBUTOR' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('Distributor negative markup is strictly rejected', async () => {
      await expect(
        service.updateDistributorMarkup('d-1', { markup: -0.5 }, { id: 'user-d1', role: 'DISTRIBUTOR' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('Super Admin updating global config creates audit log', async () => {
      const updateDto = {
        baseTicketPrice: 12,
        maxPartnerMarkup: 3,
        maxDistributorMarkup: 2.5,
      };

      await service.updatePricingConfig({ id: 'admin-1', email: 'admin@sevatn.online', role: 'SUPER_ADMIN' }, updateDto);

      expect(prisma.pricingAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'PRICING_CONFIG_UPDATED',
            targetEntity: 'PricingConfig',
          }),
        }),
      );
    });
  });
});

