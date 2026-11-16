import { Test, TestingModule } from '@nestjs/testing';
import { DistributorService } from './distributor.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TicketPricingService } from '../pricing/ticket-pricing.service';
import { ForbiddenException, NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

describe('DistributorService - Ownership & RBAC Enforcement', () => {
  let service: DistributorService;
  let prisma: any;
  let pricingService: any;
  let audit: any;

  beforeEach(async () => {
    prisma = {
      distributor: {
        count: jest.fn().mockResolvedValue(1),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      partner: {
        findUnique: jest.fn(),
      },
      user: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      distributorInvitation: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      centre: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation(async (cb) => cb(prisma)),
    };

    pricingService = {
      getPricingConfig: jest.fn().mockResolvedValue({
        baseTicketPrice: 10,
        maxPartnerMarkup: 2,
        maxDistributorMarkup: 2,
      }),
    };

    audit = {
      log: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DistributorService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: TicketPricingService, useValue: pricingService },
      ],
    }).compile();

    service = module.get<DistributorService>(DistributorService);
  });

  describe('Partner Ownership Boundaries', () => {
    it('Active Partner can create a Distributor under own account', async () => {
      prisma.partner.findUnique.mockResolvedValue({
        id: 'p-1',
        partnerCode: 'PT-001',
        status: 'ACTIVE',
      });
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.distributor.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: 'u-dist-1' });
      prisma.distributor.create.mockResolvedValue({
        id: 'd-1',
        distributorCode: 'DT-002',
        partnerId: 'p-1',
        name: 'Muthu Agencies',
        markup: new Prisma.Decimal(1),
        commissionPercentage: new Prisma.Decimal(10),
      });

      const res = await service.createDistributor(
        { id: 'user-p1' },
        'p-1',
        {
          name: 'Muthu Agencies',
          mobile: '9876543210',
          markup: 1,
          commissionSlab: 'STANDARD',
        },
      );

      expect(res.distributor.distributorCode).toBe('DT-002');
      expect(prisma.distributor.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ partnerId: 'p-1' }),
        }),
      );
    });

    it('Suspended Partner cannot create Distributors', async () => {
      prisma.partner.findUnique.mockResolvedValue({
        id: 'p-suspended',
        status: 'SUSPENDED',
      });

      await expect(
        service.createDistributor(
          { id: 'user-p-suspended' },
          'p-suspended',
          { name: 'Test', mobile: '9876543210' },
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('Partner cannot view or edit another Partner\'s Distributor', async () => {
      // Distributor belongs to p-2, but caller is p-1
      prisma.distributor.findFirst.mockResolvedValue(null);

      await expect(
        service.getPartnerDistributorById('p-1', 'dist-belonging-to-p2'),
      ).rejects.toThrow(NotFoundException);

      await expect(
        service.updateDistributor('p-1', 'dist-belonging-to-p2', { name: 'Hacked' }, { id: 'u1' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('Distributor Centre Ownership & Invitations', () => {
    it('Active Distributor can generate a 30-minute single-use Centre invitation', async () => {
      prisma.distributor.findUnique.mockResolvedValue({
        id: 'd-1',
        distributorCode: 'DT-001',
        partnerId: 'p-1',
        status: 'ACTIVE',
        partner: { status: 'ACTIVE' },
      });
      prisma.distributorInvitation.create.mockResolvedValue({
        id: 'inv-1',
        token: 'abcdef1234567890abcdef1234567890',
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      const res = await service.generateCentreInvitation('d-1', { expiresInMinutes: 30 }, { id: 'user-d1' });

      expect(res.invitation.onboardingUrl).toContain('token=');
      expect(prisma.distributorInvitation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ distributorId: 'd-1' }),
        }),
      );
    });

    it('Inactive Distributor cannot generate Centre invitations', async () => {
      prisma.distributor.findUnique.mockResolvedValue({
        id: 'd-inactive',
        status: 'INACTIVE',
        partner: { status: 'ACTIVE' },
      });

      await expect(
        service.generateCentreInvitation('d-inactive', {}, { id: 'user-d-inactive' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});

