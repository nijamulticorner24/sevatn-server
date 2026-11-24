import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdatePricingConfigDto, UpdateMarkupDto } from './dto/pricing.dto';
import { Prisma } from '@prisma/client';

export interface BookingPriceCalculationResult {
  baseTicketPrice: number;
  partnerMarkup: number;
  distributorMarkup: number;
  finalTicketPrice: number;
  ticketQuantity: number;
  totalTicketAmount: number;
  pricingConfigVersion: number;
  pricingSnapshot: {
    baseTicketPrice: number;
    partnerMarkup: number;
    distributorMarkup: number;
    finalTicketPrice: number;
    ticketQuantity: number;
    totalTicketAmount: number;
    partnerId: string | null;
    distributorId: string | null;
    calculatedAt: string;
  };
}

@Injectable()
export class TicketPricingService {
  private readonly logger = new Logger(TicketPricingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves active global pricing configuration or initializes defaults:
   * Base = ₹ 10.00, Max Partner Markup = ₹ 2.00, Max Distributor Markup = ₹ 2.00
   */
  async getPricingConfig() {
    let config = await this.prisma.pricingConfig.findUnique({
      where: { id: 'default' },
    });

    if (!config) {
      config = await this.prisma.pricingConfig.create({
        data: {
          id: 'default',
          baseTicketPrice: new Prisma.Decimal(10.0),
          maxPartnerMarkup: new Prisma.Decimal(2.0),
          maxDistributorMarkup: new Prisma.Decimal(2.0),
          isActive: true,
          version: 1,
        },
      });
      this.logger.log('Initialized default global pricing configuration (Base: ₹ 10, Max Partner: ₹ 2, Max Dist: ₹ 2)');
    }

    const baseTicketPrice = Number(config.baseTicketPrice);
    const maxPartnerMarkup = Number(config.maxPartnerMarkup);
    const maxDistributorMarkup = Number(config.maxDistributorMarkup);
    const maxPossiblePrice = baseTicketPrice + maxPartnerMarkup + maxDistributorMarkup;

    return {
      ...config,
      baseTicketPrice,
      maxPartnerMarkup,
      maxDistributorMarkup,
      maxPossiblePrice,
    };
  }

  /**
   * Super Admin updates global pricing configuration
   */
  async updatePricingConfig(adminUser: any, dto: UpdatePricingConfigDto) {
    if (dto.baseTicketPrice < 0) {
      throw new BadRequestException('Base ticket price cannot be negative.');
    }
    if (dto.maxPartnerMarkup < 0) {
      throw new BadRequestException('Maximum Partner markup cannot be negative.');
    }
    if (dto.maxDistributorMarkup < 0) {
      throw new BadRequestException('Maximum Distributor markup cannot be negative.');
    }

    const currentConfig = await this.getPricingConfig();

    const updated = await this.prisma.pricingConfig.update({
      where: { id: 'default' },
      data: {
        baseTicketPrice: new Prisma.Decimal(dto.baseTicketPrice),
        maxPartnerMarkup: new Prisma.Decimal(dto.maxPartnerMarkup),
        maxDistributorMarkup: new Prisma.Decimal(dto.maxDistributorMarkup),
        isActive: dto.isActive !== undefined ? dto.isActive : currentConfig.isActive,
        version: { increment: 1 },
        updatedBy: adminUser?.email || adminUser?.id || 'SUPER_ADMIN',
      },
    });

    // Record immutable audit history
    await this.prisma.pricingAuditLog.create({
      data: {
        actorId: adminUser?.id || 'SUPER_ADMIN',
        actorRole: adminUser?.role || 'SUPER_ADMIN',
        action: 'PRICING_CONFIG_UPDATED',
        targetEntity: 'PricingConfig',
        targetId: 'default',
        oldValues: {
          baseTicketPrice: currentConfig.baseTicketPrice,
          maxPartnerMarkup: currentConfig.maxPartnerMarkup,
          maxDistributorMarkup: currentConfig.maxDistributorMarkup,
          isActive: currentConfig.isActive,
          version: currentConfig.version,
        },
        newValues: {
          baseTicketPrice: Number(updated.baseTicketPrice),
          maxPartnerMarkup: Number(updated.maxPartnerMarkup),
          maxDistributorMarkup: Number(updated.maxDistributorMarkup),
          isActive: updated.isActive,
          version: updated.version,
        },
      },
    });

    this.logger.log(
      `[Pricing] Config updated by ${adminUser?.email}: Base=₹ ${dto.baseTicketPrice}, MaxPartner=₹ ${dto.maxPartnerMarkup}, MaxDist=₹ ${dto.maxDistributorMarkup}`,
    );

    return this.getPricingConfig();
  }

  /**
   * Get pricing audit logs for Super Admin inspection
   */
  async getPricingAuditLogs(limit = 100) {
    return this.prisma.pricingAuditLog.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get markup configuration for a specific Partner
   */
  async getPartnerMarkup(partnerId: string) {
    const config = await this.getPricingConfig();
    const partner = await (this.prisma.partner as any).findUnique({
      where: { id: partnerId },
      select: { id: true, partnerCode: true, name: true, markup: true, baseTicketPrice: true },
    });

    if (!partner) {
      throw new NotFoundException('Partner not found');
    }

    const partnerMarkup = Number(partner.markup || 0);
    const partnerBasePrice = (partner as any)?.baseTicketPrice;
    const isCustomRate =
      partnerBasePrice !== undefined && partnerBasePrice !== null && Number(partnerBasePrice) >= 0;
    const partnerBase = isCustomRate ? Number(partnerBasePrice) : config.baseTicketPrice;

    return {
      partnerId: partner.id,
      partnerCode: partner.partnerCode,
      partnerName: partner.name,
      baseTicketPrice: partnerBase,
      isCustomRate,
      currentMarkup: partnerMarkup,
      maxAllowedMarkup: config.maxPartnerMarkup,
      effectivePrice: partnerBase + partnerMarkup,
    };
  }

  /**
   * Partner updates their own markup
   */
  async updatePartnerMarkup(partnerId: string, dto: UpdateMarkupDto, user: any) {
    const config = await this.getPricingConfig();
    const markupValue = Number(dto.markup);

    if (markupValue < 0) {
      throw new BadRequestException('Markup cannot be negative.');
    }
    if (markupValue > config.maxPartnerMarkup) {
      throw new BadRequestException(
        `Partner markup (₹ ${markupValue}) cannot exceed Super Admin limit (₹ ${config.maxPartnerMarkup}).`,
      );
    }

    const existingPartner = await (this.prisma.partner as any).findUnique({
      where: { id: partnerId },
      select: { id: true, partnerCode: true, name: true, markup: true, baseTicketPrice: true },
    });
    if (!existingPartner) {
      throw new NotFoundException('Partner record not found');
    }

    const previousMarkup = Number(existingPartner.markup || 0);

    const updated = await this.prisma.partner.update({
      where: { id: partnerId },
      data: {
        markup: new Prisma.Decimal(markupValue),
      },
    });

    // Record audit entry
    await this.prisma.pricingAuditLog.create({
      data: {
        actorId: user?.id,
        actorRole: user?.role,
        action: 'PARTNER_MARKUP_CHANGED',
        targetEntity: 'Partner',
        targetId: partnerId,
        oldValues: { markup: previousMarkup },
        newValues: { markup: markupValue },
      },
    });

    const partnerBasePrice = (existingPartner as any)?.baseTicketPrice;
    const isCustomRate =
      partnerBasePrice !== undefined && partnerBasePrice !== null && Number(partnerBasePrice) >= 0;
    const partnerBase = isCustomRate ? Number(partnerBasePrice) : config.baseTicketPrice;

    return {
      partnerId: updated.id,
      partnerCode: updated.partnerCode,
      currentMarkup: Number(updated.markup),
      maxAllowedMarkup: config.maxPartnerMarkup,
      baseTicketPrice: partnerBase,
      isCustomRate,
      effectivePrice: partnerBase + Number(updated.markup),
      message: 'Partner markup successfully updated.',
    };
  }

  /**
   * Get markup configuration for a specific Distributor
   */
  async getDistributorMarkup(distributorId: string) {
    const config = await this.getPricingConfig();
    const distributor = await (this.prisma.distributor as any).findUnique({
      where: { id: distributorId },
      include: {
        partner: {
          select: { id: true, partnerCode: true, name: true, markup: true, baseTicketPrice: true },
        },
      },
    });

    if (!distributor) {
      throw new NotFoundException('Distributor not found');
    }

    const distributorMarkup = Number(distributor.markup || 0);
    const partnerMarkup = Number(distributor.partner?.markup || 0);
    const partnerBaseVal = (distributor.partner as any)?.baseTicketPrice;
    const isCustomPartnerRate =
      partnerBaseVal !== undefined &&
      partnerBaseVal !== null &&
      Number(partnerBaseVal) >= 0;
    const baseTicketPrice = isCustomPartnerRate
      ? Number(partnerBaseVal)
      : config.baseTicketPrice;
    const finalTicketPrice = baseTicketPrice + partnerMarkup + distributorMarkup;

    return {
      distributorId: distributor.id,
      distributorCode: distributor.distributorCode,
      distributorName: distributor.name,
      partnerId: distributor.partnerId,
      partnerCode: distributor.partner?.partnerCode,
      partnerName: distributor.partner?.name,
      baseTicketPrice,
      isCustomPartnerRate,
      partnerMarkup,
      currentMarkup: distributorMarkup,
      maxAllowedMarkup: config.maxDistributorMarkup,
      finalTicketPrice,
    };
  }

  /**
   * Distributor updates their own markup
   */
  async updateDistributorMarkup(distributorId: string, dto: UpdateMarkupDto, user: any) {
    const config = await this.getPricingConfig();
    const markupValue = Number(dto.markup);

    if (markupValue < 0) {
      throw new BadRequestException('Markup cannot be negative.');
    }
    if (markupValue > config.maxDistributorMarkup) {
      throw new BadRequestException(
        `Distributor markup (₹ ${markupValue}) cannot exceed Super Admin limit (₹ ${config.maxDistributorMarkup}).`,
      );
    }

    const existingDistributor = await (this.prisma.distributor as any).findUnique({
      where: { id: distributorId },
      include: {
        partner: {
          select: { id: true, partnerCode: true, name: true, markup: true, baseTicketPrice: true },
        },
      },
    });
    if (!existingDistributor) {
      throw new NotFoundException('Distributor not found');
    }

    const previousMarkup = Number(existingDistributor.markup || 0);

    const updated = await (this.prisma.distributor as any).update({
      where: { id: distributorId },
      data: {
        markup: new Prisma.Decimal(markupValue),
      },
    });

    // Record audit entry
    await this.prisma.pricingAuditLog.create({
      data: {
        actorId: user?.id,
        actorRole: user?.role,
        action: 'DISTRIBUTOR_MARKUP_CHANGED',
        targetEntity: 'Distributor',
        targetId: distributorId,
        oldValues: { markup: previousMarkup },
        newValues: { markup: markupValue },
      },
    });

    const partnerMarkup = Number(existingDistributor.partner?.markup || 0);
    const partnerBaseVal = (existingDistributor.partner as any)?.baseTicketPrice;
    const isCustomPartnerRate =
      partnerBaseVal !== undefined &&
      partnerBaseVal !== null &&
      Number(partnerBaseVal) >= 0;
    const baseTicketPrice = isCustomPartnerRate
      ? Number(partnerBaseVal)
      : config.baseTicketPrice;
    const finalTicketPrice = baseTicketPrice + partnerMarkup + markupValue;

    return {
      distributorId: updated.id,
      distributorCode: updated.distributorCode,
      currentMarkup: Number(updated.markup),
      maxAllowedMarkup: config.maxDistributorMarkup,
      baseTicketPrice,
      isCustomPartnerRate,
      partnerMarkup,
      finalTicketPrice,
      message: 'Distributor markup successfully updated.',
    };
  }

  /**
   * Calculates the full 3-level ticket price breakdown and generates the immutable snapshot for a booking.
   * Resolves: Centre -> Distributor -> Partner hierarchy server-side.
   */
  async calculateBookingPrice(params: {
    userId: string;
    quantity: number;
  }): Promise<BookingPriceCalculationResult> {
    const { userId, quantity } = params;
    const ticketQuantity = Math.max(1, Number(quantity) || 1);

    const config = await this.getPricingConfig();
    let baseTicketPrice = config.baseTicketPrice;

    // Fetch user and hierarchy relations
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        partner: true,
        distributor: {
          include: { partner: true },
        },
        distributorProfile: {
          include: { partner: true },
        },
        centre: {
          include: {
            distributor: {
              include: { partner: true },
            },
          },
        },
      },
    });

    let partnerMarkup = 0;
    let distributorMarkup = 0;
    let resolvedPartnerId: string | null = null;
    let resolvedDistributorId: string | null = null;

    // 1. Resolve Distributor and markup
    const activeDistributor = user?.distributorProfile || user?.distributor || user?.centre?.distributor;
    if (activeDistributor) {
      resolvedDistributorId = activeDistributor.id;
      // Cap at Super Admin maximum limit. If user is the distributor themselves, own markup is 0
      distributorMarkup = user?.role === 'DISTRIBUTOR' ? 0 : Math.min(Number(activeDistributor.markup || 0), config.maxDistributorMarkup);
    }

    // 2. Resolve Partner and markup (either direct partner or parent partner of distributor)
    const activePartner =
      user?.partner ||
      activeDistributor?.partner ||
      user?.centre?.distributor?.partner;

    if (activePartner) {
      resolvedPartnerId = activePartner.id;
      const partnerBaseOverride = (activePartner as any)?.baseTicketPrice;
      if (
        partnerBaseOverride !== undefined &&
        partnerBaseOverride !== null &&
        Number(partnerBaseOverride) >= 0
      ) {
        baseTicketPrice = Number(partnerBaseOverride);
      }
      // Cap at Super Admin maximum limit
      partnerMarkup = Math.min(Number(activePartner.markup || 0), config.maxPartnerMarkup);
    }

    // 3. Calculate final prices
    const finalTicketPrice = baseTicketPrice + partnerMarkup + distributorMarkup;
    const totalTicketAmount = finalTicketPrice * ticketQuantity;

    const pricingSnapshot = {
      baseTicketPrice,
      partnerMarkup,
      distributorMarkup,
      finalTicketPrice,
      ticketQuantity,
      totalTicketAmount,
      partnerId: resolvedPartnerId,
      distributorId: resolvedDistributorId,
      calculatedAt: new Date().toISOString(),
    };

    return {
      baseTicketPrice,
      partnerMarkup,
      distributorMarkup,
      finalTicketPrice,
      ticketQuantity,
      totalTicketAmount,
      pricingConfigVersion: config.version,
      pricingSnapshot,
    };
  }

  /**
   * Preview price breakdown for a centre user before booking submission
   */
  async previewBookingPrice(userId: string, quantity = 1) {
    return this.calculateBookingPrice({ userId, quantity });
  }
}

