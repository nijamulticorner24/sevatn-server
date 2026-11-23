import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TicketPricingService } from '../pricing/ticket-pricing.service';
import { EventsGateway } from '../events/events.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { S3StorageService } from '../common/storage/s3-storage.service';
import {
  CreateDistributorDto,
  UpdateDistributorDto,
  UpdateDistributorStatusDto,
  GenerateCentreInvitationDto,
} from './dto/distributor.dto';
import { Role, UserStatus, InvitationStatus, TransactionType, TransactionStatus, PayoutStatus, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class DistributorService {
  private readonly logger = new Logger(DistributorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pricingService: TicketPricingService,
    @Optional() private readonly eventsGateway?: EventsGateway,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly s3Storage?: S3StorageService,
  ) {}

  /**
   * Helper: Generate unique human-readable distributor code (e.g. DT-001)
   */
  private async generateUniqueCode(): Promise<string> {
    const count = await this.prisma.distributor.count();
    let num = count + 1;
    let code = `DT-${num.toString().padStart(3, '0')}`;
    let exists = await this.prisma.distributor.findUnique({ where: { distributorCode: code } });
    while (exists) {
      num++;
      code = `DT-${num.toString().padStart(3, '0')}`;
      exists = await this.prisma.distributor.findUnique({ where: { distributorCode: code } });
    }
    return code;
  }

  // =========================================================================
  // PARTNER MANAGEMENT OF DISTRIBUTORS
  // =========================================================================

  /**
   * Authenticated Partner creates a Distributor under their franchise
   */
  async createDistributor(partnerUser: any, partnerId: string, dto: CreateDistributorDto) {
    const cleanMobile = dto.mobile.trim();
    const cleanEmail = dto.email ? dto.email.toLowerCase().trim() : `${cleanMobile}@sevatn.online`;

    // 1. Verify Partner is active
    const partner = await this.prisma.partner.findUnique({
      where: { id: partnerId },
    });
    if (!partner || partner.status !== 'ACTIVE') {
      throw new ForbiddenException('Only active Partner franchises can create Distributors.');
    }

    // 2. Duplicate mobile or email check
    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ mobile: cleanMobile }, { email: cleanEmail }],
      },
    });
    if (existingUser) {
      throw new ConflictException(`An account with mobile ${cleanMobile} or email ${cleanEmail} already exists.`);
    }

    // 3. Verify markup within Super Admin cap
    const config = await this.pricingService.getPricingConfig();
    const markupValue = Number(dto.markup || 0);
    if (markupValue < 0 || markupValue > config.maxDistributorMarkup) {
      throw new BadRequestException(
        `Distributor markup (🪙 ${markupValue}) must be between 🪙 0 and the Super Admin cap (🪙 ${config.maxDistributorMarkup}).`,
      );
    }

    // System Config Distributor License Fee
    const sysConfig = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
    const distributorFeeAmount = Number(sysConfig?.distributorFee || 399);

    // Resolve Partner User ID for wallet deduction
    const partnerUserId: string | null = partner.userId || partnerUser?.id || null;

    // Check Partner wallet balance if creator is Partner
    if (partnerUser?.role === Role.PARTNER && partnerUserId) {
      const pWallet = await this.prisma.wallet.findUnique({ where: { userId: partnerUserId } });
      const currentAvailable = Number(pWallet?.availableBalance || 0);
      if (currentAvailable < distributorFeeAmount) {
        throw new BadRequestException(
          `Insufficient Partner Wallet Balance: Your available balance is 🪙 ${currentAvailable.toFixed(2)}, but the Distributor License Fee is 🪙 ${distributorFeeAmount.toFixed(2)}. Please recharge your partner wallet to onboard this distributor.`,
        );
      }
    }

    const distributorCode = await this.generateUniqueCode();
    const rawPassword = dto.password?.trim() || `Dist@${cleanMobile.slice(-4)}`;
    const passwordHash = await bcrypt.hash(rawPassword, 10);

    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Deduct Distributor License Fee from Partner's Wallet if creator is Partner
      let partnerWalletUpdated: any = null;
      if (partnerUser?.role === Role.PARTNER && partnerUserId) {
        let pWallet = await tx.wallet.findUnique({ where: { userId: partnerUserId } });
        if (!pWallet) {
          pWallet = await tx.wallet.create({
            data: {
              userId: partnerUserId,
              availableBalance: new Prisma.Decimal(0),
              reservedBalance: new Prisma.Decimal(0),
            },
          });
        }
        const prevBal = Number(pWallet.availableBalance);
        if (prevBal < distributorFeeAmount) {
          throw new BadRequestException(
            `Insufficient Partner Wallet Balance: Your available balance is 🪙 ${prevBal.toFixed(2)}, but the Distributor License Fee is 🪙 ${distributorFeeAmount.toFixed(2)}. Please recharge your partner wallet.`,
          );
        }
        const newBal = prevBal - distributorFeeAmount;
        partnerWalletUpdated = await tx.wallet.update({
          where: { id: pWallet.id },
          data: { availableBalance: new Prisma.Decimal(newBal) },
        });

        await tx.walletTransaction.create({
          data: {
            walletId: pWallet.id,
            userId: partnerUserId,
            type: TransactionType.ADJUSTMENT,
            amount: new Prisma.Decimal(-distributorFeeAmount),
            status: TransactionStatus.COMPLETED,
            reference: `DIST-FEE-${distributorCode}`,
            metadata: {
              description: `Distributor License Fee for ${dto.name.trim()} (${distributorCode})`,
              distributorCode,
              distributorName: dto.name.trim(),
              feeAmount: distributorFeeAmount,
              previousBalance: prevBal,
              newBalance: newBal,
            },
          },
        });
      }

      // Create User account
      const user = await tx.user.create({
        data: {
          name: dto.name.trim(),
          email: cleanEmail,
          mobile: cleanMobile,
          passwordHash,
          role: Role.DISTRIBUTOR,
          status: UserStatus.ACTIVE,
          partnerId,
          mustChangePassword: !dto.password,
        },
      });

      // Create Distributor profile
      const distributor = await tx.distributor.create({
        data: {
          distributorCode,
          partnerId,
          userId: user.id,
          name: dto.name.trim(),
          businessName: dto.businessName?.trim() || null,
          mobile: cleanMobile,
          email: dto.email ? cleanEmail : null,
          address: dto.address?.trim() || null,
          district: dto.district?.trim() || partner.district || null,
          taluk: dto.taluk?.trim() || partner.taluk || null,
          status: 'ACTIVE',
          distributorFee: new Prisma.Decimal(distributorFeeAmount),
          feePaid: true,
          paymentReference: partnerUser?.role === Role.PARTNER ? `DIST-FEE-${distributorCode}` : null,
          commissionSlab: dto.commissionSlab?.trim() || 'STANDARD',
          commissionPercentage: new Prisma.Decimal(dto.commissionPercentage !== undefined ? dto.commissionPercentage : 10.0),
          commissionRate: new Prisma.Decimal(dto.commissionRate !== undefined ? dto.commissionRate : 0.0),
          markup: new Prisma.Decimal(markupValue),
        },
      });

      // Link distributorId back to User
      await tx.user.update({
        where: { id: user.id },
        data: { distributorId: distributor.id },
      });

      return { user, distributor, partnerWalletUpdated };
    });

    if (result.partnerWalletUpdated && this.eventsGateway && partnerUserId) {
      try {
        this.eventsGateway.notifyWalletUpdated(partnerUserId, {
          availableBalance: Number(result.partnerWalletUpdated.availableBalance),
          reservedBalance: Number(result.partnerWalletUpdated.reservedBalance),
        });
      } catch (_) {}
    }

    await this.audit.log({
      actorId: partnerUser?.id,
      actorType: 'USER',
      action: 'DISTRIBUTOR_CREATED',
      entity: 'Distributor',
      entityId: result.distributor.id,
      metadata: {
        partnerId,
        distributorCode,
        distributorName: dto.name,
        mobile: cleanMobile,
        markup: markupValue,
        commissionSlab: dto.commissionSlab || 'STANDARD',
      },
    });

    this.logger.log(`[Distributor Created] ${distributorCode} under partner ${partner.partnerCode}`);

    return {
      message: 'Distributor created successfully',
      distributor: {
        ...result.distributor,
        name: result.user.name,
        email: result.user.email,
        mobile: result.user.mobile,
        businessName: dto.businessName?.trim() || null,
        markup: Number(result.distributor.markup),
        commissionPercentage: Number(result.distributor.commissionPercentage),
      },
      credentials: {
        identifier: cleanMobile,
        temporaryPassword: dto.password ? 'User Defined' : rawPassword,
        portalUrl: '/auth/login',
      },
    };
  }

  /**
   * List all Distributors belonging to a Partner
   */
  async getPartnerDistributors(partnerId: string, query?: any) {
    const distributors = await this.prisma.distributor.findMany({
      where: { partnerId },
      include: {
        _count: {
          select: { centres: true, registeredUsers: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const config = await this.pricingService.getPricingConfig();

    return distributors.map((d) => ({
      ...d,
      markup: Number(d.markup),
      commissionPercentage: Number(d.commissionPercentage),
      centresCount: d._count.centres,
      registeredUsersCount: d._count.registeredUsers,
      maxAllowedMarkup: config.maxDistributorMarkup,
    }));
  }

  /**
   * Get single Distributor details with owned Centres
   */
  async getPartnerDistributorById(partnerId: string, distributorId: string) {
    const distributor = await this.prisma.distributor.findFirst({
      where: { id: distributorId, partnerId },
      include: {
        partner: {
          select: { id: true, partnerCode: true, name: true, markup: true },
        },
        centres: {
          orderBy: { createdAt: 'desc' },
          include: {
            user: { select: { id: true, name: true, mobile: true, email: true, status: true, registrationDate: true } },
          },
        },
        invitations: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
        _count: {
          select: { centres: true, invitations: true },
        },
      },
    });

    if (!distributor) {
      throw new NotFoundException('Distributor not found or access denied');
    }

    const config = await this.pricingService.getPricingConfig();
    const now = new Date();
    const activeCentres = distributor.centres.filter((c) => c.status === 'ACTIVE').length;
    const pendingInvitations = distributor.invitations.filter(
      (inv) => inv.status === 'ACTIVE' && (!inv.expiresAt || new Date(inv.expiresAt) > now) && !inv.usedAt,
    ).length;

    return {
      ...distributor,
      markup: Number(distributor.markup),
      commissionPercentage: Number(distributor.commissionPercentage),
      partnerMarkup: Number(distributor.partner.markup || 0),
      baseTicketPrice:
        (distributor.partner as any)?.baseTicketPrice !== undefined &&
        (distributor.partner as any)?.baseTicketPrice !== null &&
        Number((distributor.partner as any).baseTicketPrice) >= 0
          ? Number((distributor.partner as any).baseTicketPrice)
          : config.baseTicketPrice,
      maxAllowedMarkup: config.maxDistributorMarkup,
      finalTicketPrice:
        ((distributor.partner as any)?.baseTicketPrice !== undefined &&
        (distributor.partner as any)?.baseTicketPrice !== null &&
        Number((distributor.partner as any).baseTicketPrice) >= 0
          ? Number((distributor.partner as any).baseTicketPrice)
          : config.baseTicketPrice) +
        Number(distributor.partner.markup || 0) +
        Number(distributor.markup),
      totalCentres: distributor.centres.length,
      activeCentres,
      pendingInvitations,
    };
  }

  /**
   * Update Distributor details, commission slab, or markup by Partner
   */
  async updateDistributor(
    partnerId: string,
    distributorId: string,
    dto: UpdateDistributorDto,
    partnerUser: any,
  ) {
    const distributor = await this.prisma.distributor.findFirst({
      where: { id: distributorId, partnerId },
    });
    if (!distributor) {
      throw new NotFoundException('Distributor not found or access denied');
    }

    const config = await this.pricingService.getPricingConfig();
    const updateData: any = {};

    if (dto.name) updateData.name = dto.name.trim();
    if (dto.businessName !== undefined) updateData.businessName = dto.businessName?.trim() || null;
    if (dto.address !== undefined) updateData.address = dto.address?.trim() || null;
    if (dto.district) updateData.district = dto.district.trim();
    if (dto.taluk) updateData.taluk = dto.taluk.trim();
    if (dto.commissionSlab) updateData.commissionSlab = dto.commissionSlab.trim();
    if (dto.commissionPercentage !== undefined) {
      updateData.commissionPercentage = new Prisma.Decimal(Number(dto.commissionPercentage));
    }
    if (dto.commissionRate !== undefined) {
      updateData.commissionRate = new Prisma.Decimal(Number(dto.commissionRate));
    }
    if (dto.markup !== undefined) {
      const markupNum = Number(dto.markup);
      if (markupNum < 0 || markupNum > config.maxDistributorMarkup) {
        throw new BadRequestException(
          `Markup (🪙 ${markupNum}) must be between 🪙 0 and the Super Admin cap (🪙 ${config.maxDistributorMarkup}).`,
        );
      }
      updateData.markup = new Prisma.Decimal(markupNum);
    }
    if (dto.status) {
      updateData.status = dto.status;
    }

    const updated = await this.prisma.distributor.update({
      where: { id: distributorId },
      data: updateData,
    });

    // Update linked user if name or status changed
    if (distributor.userId) {
      const userUpdate: any = {};
      if (dto.name) userUpdate.name = dto.name.trim();
      if (dto.status) {
        userUpdate.status = dto.status === 'ACTIVE' ? UserStatus.ACTIVE : UserStatus.SUSPENDED;
      }
      if (dto.password) {
        userUpdate.passwordHash = await bcrypt.hash(dto.password.trim(), 10);
      }
      if (Object.keys(userUpdate).length > 0) {
        await this.prisma.user.update({
          where: { id: distributor.userId },
          data: userUpdate,
        });
      }
    }

    await this.audit.log({
      actorId: partnerUser?.id,
      actorType: 'USER',
      action: 'DISTRIBUTOR_UPDATED',
      entity: 'Distributor',
      entityId: distributorId,
      metadata: {
        partnerId,
        previousMarkup: Number(distributor.markup),
        newMarkup: dto.markup !== undefined ? Number(dto.markup) : Number(distributor.markup),
        commissionSlab: dto.commissionSlab || distributor.commissionSlab,
      },
    });

    return {
      message: 'Distributor updated successfully',
      distributor: {
        ...updated,
        markup: Number(updated.markup),
        commissionPercentage: Number(updated.commissionPercentage),
      },
    };
  }

  /**
   * Activate / Deactivate Distributor by Partner
   */
  async updateDistributorStatus(
    partnerId: string,
    distributorId: string,
    dto: UpdateDistributorStatusDto,
    partnerUser: any,
  ) {
    const distributor = await this.prisma.distributor.findFirst({
      where: { id: distributorId, partnerId },
    });
    if (!distributor) {
      throw new NotFoundException('Distributor not found or access denied');
    }

    const updated = await this.prisma.distributor.update({
      where: { id: distributorId },
      data: { status: dto.status },
    });

    if (distributor.userId) {
      await this.prisma.user.update({
        where: { id: distributor.userId },
        data: {
          status: dto.status === 'ACTIVE' ? UserStatus.ACTIVE : UserStatus.SUSPENDED,
        },
      });
    }

    await this.audit.log({
      actorId: partnerUser?.id,
      actorType: 'USER',
      action: 'DISTRIBUTOR_STATUS_CHANGED',
      entity: 'Distributor',
      entityId: distributorId,
      metadata: {
        partnerId,
        oldStatus: distributor.status,
        newStatus: dto.status,
        reason: dto.reason || null,
      },
    });

    return {
      message: `Distributor status updated to ${dto.status}`,
      distributor: {
        id: updated.id,
        status: updated.status,
      },
    };
  }

  /**
   * Regenerate temporary password for a Distributor by their Partner franchise
   */
  async regenerateDistributorPassword(partnerId: string, distributorId: string, partnerUser: any) {
    const distributor = await this.prisma.distributor.findFirst({
      where: { id: distributorId, partnerId },
      include: { user: true },
    });
    if (!distributor) {
      throw new NotFoundException('Distributor not found or access denied');
    }
    if (!distributor.userId) {
      throw new BadRequestException('Distributor does not have an associated login user account');
    }

    const cleanMobile = distributor.mobile.trim();
    // Generate secure temporary password, e.g. Dist@ followed by 4 random digits
    const randomDigits = Math.floor(1000 + Math.random() * 9000);
    const tempPassword = `Dist@${randomDigits}`;
    const passwordHash = await bcrypt.hash(tempPassword, 10);

    await this.prisma.user.update({
      where: { id: distributor.userId },
      data: {
        passwordHash,
        mustChangePassword: true,
      },
    });

    await this.audit.log({
      actorId: partnerUser?.id,
      actorType: 'USER',
      action: 'DISTRIBUTOR_PASSWORD_REGENERATED',
      entity: 'Distributor',
      entityId: distributorId,
      metadata: {
        partnerId,
        distributorCode: distributor.distributorCode,
        distributorName: distributor.name,
        mobile: cleanMobile,
      },
    });

    this.logger.log(`[Password Regenerated] Distributor ${distributor.distributorCode} (${distributor.name}) by partner ${partnerId}`);

    return {
      message: 'Temporary password regenerated successfully',
      distributor: {
        id: distributor.id,
        distributorCode: distributor.distributorCode,
        name: distributor.name,
        businessName: distributor.businessName,
        mobile: cleanMobile,
        email: distributor.email,
      },
      credentials: {
        identifier: cleanMobile,
        temporaryPassword: tempPassword,
        portalUrl: '/auth/login',
      },
    };
  }


  // =========================================================================
  // DISTRIBUTOR PORTAL METHODS (DISTRIBUTOR SELF-SERVICE)
  // =========================================================================

  /**
   * Get overview statistics for the logged-in Distributor
   */
  async getDistributorOverview(distributorId: string) {
    const distributor = await this.prisma.distributor.findUnique({
      where: { id: distributorId },
      include: {
        partner: {
          select: { id: true, partnerCode: true, name: true, mobile: true, email: true, district: true, taluk: true, markup: true },
        },
        centres: true,
        invitations: true,
      },
    });

    if (!distributor) {
      throw new NotFoundException('Distributor record not found');
    }

    const config = await this.pricingService.getPricingConfig();
    const totalCentres = distributor.centres.length;
    const activeCentres = distributor.centres.filter((c) => c.status === 'ACTIVE').length;
    const pendingInvites = distributor.invitations.filter((i) => i.status === 'ACTIVE').length;

    const partnerBaseVal = (distributor.partner as any)?.baseTicketPrice;
    const isCustomPartnerRate =
      partnerBaseVal !== undefined &&
      partnerBaseVal !== null &&
      Number(partnerBaseVal) >= 0;
    const baseTicketPrice = isCustomPartnerRate ? Number(partnerBaseVal) : config.baseTicketPrice;
    const partnerMarkup = Number(distributor.partner?.markup || 0);
    const distributorMarkup = Number(distributor.markup || 0);
    const finalTicketPrice = baseTicketPrice + partnerMarkup + distributorMarkup;

    return {
      distributor: {
        id: distributor.id,
        distributorCode: distributor.distributorCode,
        name: distributor.name,
        businessName: distributor.businessName,
        status: distributor.status,
        district: distributor.district,
        taluk: distributor.taluk,
        commissionSlab: distributor.commissionSlab,
        partner: distributor.partner,
      },
      metrics: {
        totalCentres,
        activeCentres,
        pendingInvites,
      },
      pricing: {
        baseTicketPrice,
        partnerMarkup,
        distributorMarkup,
        maxAllowedMarkup: config.maxDistributorMarkup,
        finalTicketPrice,
      },
    };
  }

  /**
   * Get profile for logged-in Distributor
   */
  async getDistributorProfile(distributorId: string) {
    const distributor = await this.prisma.distributor.findUnique({
      where: { id: distributorId },
      include: {
        partner: {
          select: { id: true, partnerCode: true, name: true, mobile: true, email: true, district: true, taluk: true },
        },
      },
    });
    if (!distributor) {
      throw new NotFoundException('Distributor record not found');
    }
    return {
      ...distributor,
      markup: Number(distributor.markup),
      commissionPercentage: Number(distributor.commissionPercentage),
    };
  }

  /**
   * List Centres created by this Distributor
   */
  async getDistributorCentres(distributorId: string, page = 1, limit = 50, search?: string) {
    const where: Prisma.CentreWhereInput = {
      distributorId,
    };

    if (search) {
      const q = search.trim();
      where.OR = [
        { centreName: { contains: q, mode: 'insensitive' } },
        { centreCode: { contains: q, mode: 'insensitive' } },
        { district: { contains: q, mode: 'insensitive' } },
        { user: { mobile: { contains: q } } },
      ];
    }

    const [centres, total] = await Promise.all([
      this.prisma.centre.findMany({
        where,
        include: {
          user: {
            select: { id: true, name: true, mobile: true, email: true, status: true, createdAt: true, mustChangePassword: true, wallet: { select: { availableBalance: true } } },
          },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.centre.count({ where }),
    ]);

    return {
      centres,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Distributor generates a 30-minute single-use onboarding invitation link for a Centre
   */
  async generateCentreInvitation(distributorId: string, dto: GenerateCentreInvitationDto, user: any) {
    const distributor = await this.prisma.distributor.findUnique({
      where: { id: distributorId },
      include: { partner: true },
    });

    if (!distributor || distributor.status !== 'ACTIVE') {
      throw new ForbiddenException('Only active Distributors can issue Centre invitations.');
    }
    if (distributor.partner?.status !== 'ACTIVE') {
      throw new ForbiddenException('Parent Partner franchise is currently suspended or inactive.');
    }

    const token = randomBytes(24).toString('hex');
    const minutes = dto.expiresInMinutes || 30;
    const expiresAt = new Date(Date.now() + minutes * 60 * 1000);

    const invitation = await this.prisma.distributorInvitation.create({
      data: {
        distributorId,
        token,
        status: InvitationStatus.ACTIVE,
        expiresAt,
        metadata: dto.metadata || {},
      },
    });

    await this.audit.log({
      actorId: user?.id,
      actorType: 'USER',
      action: 'DISTRIBUTOR_INVITATION_GENERATED',
      entity: 'DistributorInvitation',
      entityId: invitation.id,
      metadata: {
        distributorId,
        distributorCode: distributor.distributorCode,
        partnerId: distributor.partnerId,
        expiresAt,
      },
    });

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/+$/, '');
    const onboardingUrl = `${frontendUrl}/auth/register?token=${token}`;

    return {
      message: 'Centre onboarding link created successfully (valid for 30 minutes)',
      invitation: {
        id: invitation.id,
        token: invitation.token,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        onboardingUrl,
      },
    };
  }

  /**
   * List all centre invitations issued by this Distributor
   */
  async getDistributorInvitations(distributorId: string) {
    const invitations = await this.prisma.distributorInvitation.findMany({
      where: { distributorId },
      include: {
        usedByUser: {
          select: { id: true, name: true, mobile: true, email: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/+$/, '');

    return invitations.map((inv) => ({
      ...inv,
      onboardingUrl: `${frontendUrl}/auth/register?token=${inv.token}`,
      isExpired: inv.expiresAt ? new Date() > inv.expiresAt : false,
    }));
  }

  /**
   * Regenerate an expired Centre invitation with a fresh 30-minute token
   */
  async regenerateCentreInvitation(distributorId: string, invitationId: string, user: any) {
    const existing = await this.prisma.distributorInvitation.findFirst({
      where: { id: invitationId, distributorId },
    });

    if (!existing) {
      throw new NotFoundException('Invitation not found');
    }

    const token = randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

    const updated = await this.prisma.distributorInvitation.update({
      where: { id: invitationId },
      data: {
        token,
        status: InvitationStatus.ACTIVE,
        expiresAt,
        usedAt: null,
        usedByUserId: null,
      },
    });

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3001').replace(/\/+$/, '');

    return {
      message: 'Invitation regenerated with fresh 30-minute token',
      invitation: {
        ...updated,
        onboardingUrl: `${frontendUrl}/auth/register?token=${token}`,
      },
    };
  }

  // =========================================================================
  // SUPER ADMIN OVERVIEW OF ALL DISTRIBUTORS
  // =========================================================================

  async getAllDistributorsAdmin(query?: any) {
    const distributors = await this.prisma.distributor.findMany({
      include: {
        partner: {
          select: { id: true, partnerCode: true, name: true, district: true },
        },
        user: {
          select: {
            id: true,
            email: true,
            mobile: true,
            wallet: true,
          },
        },
        _count: {
          select: { centres: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return distributors.map((d) => ({
      ...d,
      mobile: d.mobile || d.user?.mobile || '',
      email: d.email || d.user?.email || null,
      markup: Number(d.markup),
      centresCount: d._count.centres,
      wallet: d.user?.wallet || null,
      availableBalance: Number(d.user?.wallet?.availableBalance ?? 0),
      reservedBalance: Number(d.user?.wallet?.reservedBalance ?? 0),
    }));
  }

  /**
   * Super Admin adjusts a distributor's wallet balance (CREDIT or DEBIT)
   */
  async adjustDistributorWallet(
    adminUser: any,
    distributorId: string,
    dto: { amount: number; action: 'CREDIT' | 'DEBIT'; reason?: string },
  ) {
    const amount = Number(dto.amount);
    if (!amount || isNaN(amount) || amount <= 0) {
      throw new BadRequestException('Adjustment amount must be a positive number greater than 0.');
    }

    if (dto.action !== 'CREDIT' && dto.action !== 'DEBIT') {
      throw new BadRequestException("Action must be either 'CREDIT' or 'DEBIT'.");
    }

    const distributor = await this.prisma.distributor.findUnique({
      where: { id: distributorId },
      include: {
        user: {
          include: {
            wallet: true,
          },
        },
      },
    });

    if (!distributor) {
      throw new NotFoundException(`Distributor with ID '${distributorId}' not found`);
    }

    // Resolve distributor user
    let userId = distributor.userId;
    if (!userId && distributor.user?.id) {
      userId = distributor.user.id;
    }

    if (!userId) {
      // Find user by mobile or email if unlinked
      const existingUser = await this.prisma.user.findFirst({
        where: {
          OR: [
            { mobile: distributor.mobile },
            ...(distributor.email ? [{ email: distributor.email }] : []),
          ],
        },
      });

      if (existingUser) {
        userId = existingUser.id;
        await this.prisma.distributor.update({
          where: { id: distributor.id },
          data: { userId },
        });
      } else {
        throw new BadRequestException(
          `Distributor '${distributor.distributorCode}' does not have an active user account linked. Cannot adjust wallet.`,
        );
      }
    }

    return await this.prisma.$transaction(
      async (tx) => {
      // 1. Get or create wallet for the distributor user
      let wallet = distributor.user?.wallet;
      if (!wallet) {
        wallet = await tx.wallet.findUnique({ where: { userId } });
      }

      if (!wallet) {
        wallet = await tx.wallet.create({
          data: {
            userId,
            availableBalance: new Prisma.Decimal(0),
            reservedBalance: new Prisma.Decimal(0),
          },
        });
      }

      const prevAvailable = Number(wallet.availableBalance);
      let newAvailable: number;

      if (dto.action === 'CREDIT') {
        newAvailable = prevAvailable + amount;
      } else {
        if (prevAvailable < amount) {
          throw new BadRequestException(
            `Cannot deduct 🪙 ${amount}: Insufficient available balance (Current balance: 🪙 ${prevAvailable.toFixed(2)}).`,
          );
        }
        newAvailable = prevAvailable - amount;
      }

      // 2. Update wallet
      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableBalance: new Prisma.Decimal(newAvailable),
        },
      });

      // 3. Create audit transaction record
      const transaction = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          userId,
          type: TransactionType.ADJUSTMENT,
          amount: new Prisma.Decimal(dto.action === 'CREDIT' ? amount : -amount),
          status: TransactionStatus.COMPLETED,
          reference: `ADMIN-DT-${dto.action}-${Date.now()}`,
          metadata: {
            adminId: adminUser.id,
            adminEmail: adminUser.email,
            action: dto.action,
            amount,
            reason: dto.reason?.trim() || `Manual Admin ${dto.action === 'CREDIT' ? 'Credit' : 'Deduction'}`,
            previousBalance: prevAvailable,
            newBalance: newAvailable,
            distributorCode: distributor.distributorCode,
            distributorName: distributor.name,
          },
        },
      });

      // 4. Audit log
      await this.audit.log({
        actorId: adminUser.id,
        actorType: 'ADMIN',
        action: dto.action === 'CREDIT' ? 'DISTRIBUTOR_WALLET_CREDIT' : 'DISTRIBUTOR_WALLET_DEBIT',
        entity: 'Wallet',
        entityId: wallet.id,
        metadata: {
          distributorId: distributor.id,
          distributorCode: distributor.distributorCode,
          distributorName: distributor.name,
          action: dto.action,
          amount,
          previousBalance: prevAvailable,
          newBalance: newAvailable,
          reason: dto.reason || null,
        },
      });

      if (this.eventsGateway) {
        this.eventsGateway.notifyWalletUpdated(userId, {
          availableBalance: newAvailable,
          reservedBalance: Number(wallet.reservedBalance),
        });
      }

      return {
        success: true,
        message: `Successfully ${dto.action === 'CREDIT' ? 'credited' : 'deducted'} 🪙 ${amount.toFixed(2)} ${dto.action === 'CREDIT' ? 'to' : 'from'} ${distributor.name}'s wallet. New balance: 🪙 ${newAvailable.toFixed(2)}.`,
        availableBalance: newAvailable,
        wallet: updatedWallet,
        transaction,
      };
    });
  }

  /**
   * Super Admin deletes a distributor account and cleans up user profile
   */
  async deleteDistributor(adminUser: any, distributorId: string) {
    const distributor = await this.prisma.distributor.findFirst({
      where: {
        OR: [{ id: distributorId }, { distributorCode: distributorId }],
      },
      include: {
        user: {
          include: {
            wallet: true,
          },
        },
        _count: {
          select: {
            centres: true,
            payouts: true,
          },
        },
      },
    });

    if (!distributor) {
      throw new NotFoundException('Distributor profile not found');
    }

    // Safety check: Prevent deletion if there are pending payouts
    const pendingPayouts = await this.prisma.distributorPayout.count({
      where: {
        distributorId: distributor.id,
        status: PayoutStatus.REQUESTED,
      },
    });

    if (pendingPayouts > 0) {
      throw new BadRequestException(
        `Cannot delete distributor '${distributor.name}' (${distributor.distributorCode}) because they have ${pendingPayouts} pending payout request(s). Please settle or reject the payout requests first.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // 1. Detach any centres affiliated with this distributor
      await tx.centre.updateMany({
        where: { distributorId: distributor.id },
        data: { distributorId: null },
      });

      // 2. Detach any users registered under this distributor
      await tx.user.updateMany({
        where: { distributorId: distributor.id },
        data: { distributorId: null },
      });

      // 3. Delete the distributor record (cascades to distributor invitations and payouts)
      await tx.distributor.delete({
        where: { id: distributor.id },
      });

      // 4. Delete the associated user account if one exists
      if (distributor.userId) {
        await tx.user.delete({
          where: { id: distributor.userId },
        }).catch(() => {});
      }
    });

    // Write audit log
    await this.audit.log({
      actorId: adminUser?.id || null,
      actorType: 'ADMIN',
      action: 'DISTRIBUTOR_DELETED',
      entity: 'Distributor',
      entityId: distributor.id,
      metadata: {
        distributorId: distributor.id,
        distributorCode: distributor.distributorCode,
        name: distributor.name,
        businessName: distributor.businessName,
        mobile: distributor.mobile,
        email: distributor.email,
        partnerId: distributor.partnerId,
        detachedCentresCount: distributor._count.centres,
        deletedByUserId: adminUser?.id,
        deletedByEmail: adminUser?.email,
      },
    });

    // Emit event for real-time dashboards
    try {
      this.eventsGateway?.server?.emit('distributor:deleted', {
        id: distributor.id,
        distributorCode: distributor.distributorCode,
      });
    } catch (_) {}

    return {
      success: true,
      message: `Distributor '${distributor.name}' (${distributor.distributorCode}) has been permanently deleted.`,
    };
  }

  /**
   * Helper to resolve the active Distributor record ID for a requesting user
   */
  async resolveDistributorIdForUser(user: any): Promise<string> {
    let distributorId = user?.distributorProfile?.id || user?.distributorId;
    if (!distributorId && user?.id) {
      const d = await this.prisma.distributor.findFirst({
        where: {
          OR: [
            { userId: user.id },
            ...(user.mobile ? [{ mobile: user.mobile }] : []),
            ...(user.email ? [{ email: user.email }] : []),
          ],
        },
      });
      if (d) distributorId = d.id;
    }
    if (!distributorId) {
      throw new BadRequestException('User is not associated with any active Distributor account.');
    }
    return distributorId;
  }

  /**
   * Transfer / Share wallet balance from Distributor to one of their network Centres
   */
  async transferWalletToCentre(
    actorUser: any,
    distributorId: string,
    dto: { centreId: string; amount: number; notes?: string },
  ) {
    const amount = Number(dto.amount);
    if (!amount || isNaN(amount) || amount <= 0) {
      throw new BadRequestException('Transfer amount must be a positive number greater than 0.');
    }

    if (!dto.centreId) {
      throw new BadRequestException('Please select a valid destination Centre.');
    }

    const distributor = await this.prisma.distributor.findUnique({
      where: { id: distributorId },
      include: {
        user: {
          include: { wallet: true },
        },
      },
    });

    if (!distributor) {
      throw new NotFoundException(`Distributor '${distributorId}' not found.`);
    }

    // Resolve distributor user & wallet
    let distUserId = distributor.userId || distributor.user?.id;
    if (!distUserId) {
      const existingUser = await this.prisma.user.findFirst({
        where: {
          OR: [
            { mobile: distributor.mobile },
            ...(distributor.email ? [{ email: distributor.email }] : []),
          ],
        },
      });
      if (existingUser) {
        distUserId = existingUser.id;
        await this.prisma.distributor.update({
          where: { id: distributor.id },
          data: { userId: distUserId },
        });
      } else {
        throw new BadRequestException('Distributor does not have an active user account.');
      }
    }

    // Target centre
    const centre = await this.prisma.centre.findUnique({
      where: { id: dto.centreId },
      include: {
        user: {
          include: { wallet: true },
        },
      },
    });

    if (!centre) {
      throw new NotFoundException(`Target Centre with ID '${dto.centreId}' not found.`);
    }

    // Ensure centre belongs to distributor (unless actor is SUPER_ADMIN)
    if (centre.distributorId !== distributor.id && actorUser.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException(`Centre '${centre.centreName}' does not belong to your network.`);
    }

    const centreUserId = centre.userId || centre.user?.id;
    if (!centreUserId) {
      throw new BadRequestException(`Target Centre '${centre.centreName}' has no user account associated.`);
    }

    return await this.prisma.$transaction(
      async (tx) => {
      // 1. Get or create distributor wallet
      let distWallet = await tx.wallet.findUnique({ where: { userId: distUserId } });
      if (!distWallet) {
        distWallet = await tx.wallet.create({
          data: {
            userId: distUserId,
            availableBalance: new Prisma.Decimal(0),
            reservedBalance: new Prisma.Decimal(0),
          },
        });
      }

      const distPrevAvailable = Number(distWallet.availableBalance);
      if (distPrevAvailable < amount) {
        throw new BadRequestException(
          `Insufficient wallet balance: Your available balance is 🪙 ${distPrevAvailable.toFixed(2)}, cannot transfer 🪙 ${amount.toFixed(2)}.`,
        );
      }

      // 2. Get or create centre wallet
      let centreWallet = await tx.wallet.findUnique({ where: { userId: centreUserId } });
      if (!centreWallet) {
        centreWallet = await tx.wallet.create({
          data: {
            userId: centreUserId,
            availableBalance: new Prisma.Decimal(0),
            reservedBalance: new Prisma.Decimal(0),
          },
        });
      }

      const centrePrevAvailable = Number(centreWallet.availableBalance);

      // 3. Update balances
      const distNewAvailable = distPrevAvailable - amount;
      const centreNewAvailable = centrePrevAvailable + amount;

      await tx.wallet.update({
        where: { id: distWallet.id },
        data: { availableBalance: new Prisma.Decimal(distNewAvailable) },
      });

      await tx.wallet.update({
        where: { id: centreWallet.id },
        data: { availableBalance: new Prisma.Decimal(centreNewAvailable) },
      });

      const transferRef = `SHARE-${Date.now().toString().slice(-8)}`;

      // 4. Create distributor transaction record (debit)
      const distTx = await tx.walletTransaction.create({
        data: {
          walletId: distWallet.id,
          userId: distUserId,
          type: TransactionType.ADJUSTMENT,
          amount: new Prisma.Decimal(-amount),
          status: TransactionStatus.COMPLETED,
          reference: transferRef,
          metadata: {
            kind: 'WALLET_SHARE_OUT',
            direction: 'DEBIT',
            centreId: centre.id,
            centreName: centre.centreName,
            centreCode: centre.centreCode,
            notes: dto.notes?.trim() || 'Wallet Balance Shared to Centre',
            previousBalance: distPrevAvailable,
            newBalance: distNewAvailable,
          },
        },
      });

      // 5. Create centre transaction record (credit)
      const centreTx = await tx.walletTransaction.create({
        data: {
          walletId: centreWallet.id,
          userId: centreUserId,
          type: TransactionType.TOPUP,
          amount: new Prisma.Decimal(amount),
          status: TransactionStatus.COMPLETED,
          reference: transferRef,
          metadata: {
            kind: 'WALLET_SHARE_IN',
            direction: 'CREDIT',
            distributorId: distributor.id,
            distributorName: distributor.name,
            distributorCode: distributor.distributorCode,
            notes: dto.notes?.trim() || 'Wallet Balance Received from Distributor',
            previousBalance: centrePrevAvailable,
            newBalance: centreNewAvailable,
          },
        },
      });

      // 6. Audit log
      await this.audit.log({
        actorId: actorUser.id,
        actorType: 'USER',
        action: 'DISTRIBUTOR_WALLET_SHARE_TO_CENTRE',
        entity: 'Wallet',
        entityId: distWallet.id,
        metadata: {
          distributorId: distributor.id,
          distributorCode: distributor.distributorCode,
          centreId: centre.id,
          centreName: centre.centreName,
          centreCode: centre.centreCode,
          amount,
          transferRef,
          notes: dto.notes?.trim() || null,
        },
      });

      // 7. WebSocket live event dispatch
      if (this.eventsGateway) {
        this.eventsGateway.notifyWalletUpdated(distUserId, {
          availableBalance: distNewAvailable,
          reservedBalance: Number(distWallet.reservedBalance),
        });
        this.eventsGateway.notifyWalletUpdated(centreUserId, {
          availableBalance: centreNewAvailable,
          reservedBalance: Number(centreWallet.reservedBalance),
        });
      }

      return {
        success: true,
        message: `Successfully transferred 🪙 ${amount.toFixed(2)} to ${centre.centreName} (${centre.centreCode})`,
        transferRef,
        amount,
        newBalance: distNewAvailable,
        centre: {
          id: centre.id,
          centreName: centre.centreName,
          centreCode: centre.centreCode,
          district: centre.district,
          newBalance: centreNewAvailable,
        },
        transaction: distTx,
      };
    }, {
      maxWait: 15000,
      timeout: 30000,
    });
  }

  // =========================================================================
  // DISTRIBUTOR EARNINGS & PAYOUTS
  // =========================================================================

  /**
   * Get earnings summary and payout history for a distributor
   */
  async getDistributorPayouts(distributorId: string) {
    const distributor = await this.prisma.distributor.findUnique({
      where: { id: distributorId },
      include: {
        partner: true,
        centres: true,
      },
    });

    if (!distributor) {
      throw new NotFoundException('Distributor account not found');
    }

    const payouts = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "DistributorPayout" WHERE "distributorId" = $1 ORDER BY "createdAt" DESC`,
      distributorId,
    );

    const totalSettled = payouts
      .filter((p: any) => p.status === 'SETTLED')
      .reduce((sum: number, p: any) => sum + Number(p.amount), 0);

    const pendingWithdrawal = payouts
      .filter((p: any) => p.status === 'REQUESTED' || p.status === 'PROCESSING')
      .reduce((sum: number, p: any) => sum + Number(p.amount), 0);

    const centres = distributor.centres || [];
    const centreUserIds = centres.map((c) => c.userId).filter(Boolean) as string[];

    const confirmedBookings = centreUserIds.length > 0
      ? await this.prisma.bookingRequest.findMany({
          where: {
            userId: { in: centreUserIds },
            OR: [
              { status: { in: ['SUCCESS', 'COMPLETED', 'BOOKING_CONFIRMED'] } },
              { officialReference: { not: null } },
            ],
          },
          select: {
            distributorMarkup: true,
            ticketQuantity: true,
          },
        })
      : [];

    const bookingMarkupEarnings = confirmedBookings.reduce((sum, b) => {
      const markup = Number(b.distributorMarkup || distributor.markup || 0);
      const qty = b.ticketQuantity || 1;
      return sum + markup * qty;
    }, 0);

    const baseBalance = Number((distributor as any).balance || 0) + bookingMarkupEarnings;
    const availableBalance = Math.max(0, baseBalance - pendingWithdrawal - totalSettled);
    const totalEarned = baseBalance;

    const config = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
    const minWithdrawal = (config as any)?.partnerMinWithdrawal ? Number((config as any).partnerMinWithdrawal) : 100;

    return {
      distributor: {
        id: distributor.id,
        distributorCode: distributor.distributorCode,
        name: distributor.name,
        businessName: distributor.businessName,
        district: distributor.district,
        taluk: distributor.taluk,
        mobile: distributor.mobile,
        markup: Number(distributor.markup || 0),
        commissionSlab: distributor.commissionSlab || 'STANDARD',
        partner: distributor.partner
          ? {
              id: distributor.partner.id,
              name: distributor.partner.name,
              partnerCode: distributor.partner.partnerCode,
            }
          : null,
      },
      minWithdrawal,
      availableBalance,
      totalEarned,
      totalSettled,
      pendingWithdrawal,
      markupRate: Number(distributor.markup || 0),
      totalCentres: centres.length,
      confirmedBookingsCount: confirmedBookings.length,
      bookingMarkupEarnings,
      payouts: payouts.map((p: any) => ({
        id: p.id,
        amount: Number(p.amount),
        upiId: p.upiId,
        accountHolder: p.accountHolder,
        status: p.status,
        paymentReference: p.paymentReference,
        screenshotUrl: p.screenshotUrl,
        adminNotes: p.adminNotes,
        requestedAt: p.requestedAt,
        settledAt: p.settledAt,
        createdAt: p.createdAt,
      })),
    };
  }

  /**
   * Distributor requests UPI payout / withdrawal
   */
  async requestDistributorPayout(
    actorUser: any,
    distributorId: string,
    dto: { amount: number; upiId: string; accountHolder?: string; notes?: string },
  ) {
    const config = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
    const minWithdrawal = (config as any)?.partnerMinWithdrawal ? Number((config as any).partnerMinWithdrawal) : 100;

    const amount = Number(dto.amount);
    if (!amount || amount < minWithdrawal) {
      throw new BadRequestException(`Minimum withdrawal amount is 🪙 ${minWithdrawal}`);
    }

    const cleanUpi = dto.upiId?.trim();
    if (!cleanUpi || !cleanUpi.includes('@')) {
      throw new BadRequestException('Please enter a valid UPI ID (e.g. name@okhdfcbank or 9876543210@paytm)');
    }

    const summary = await this.getDistributorPayouts(distributorId);
    if (amount > summary.availableBalance) {
      throw new BadRequestException(
        `Requested amount (🪙 ${amount}) exceeds available balance (🪙 ${summary.availableBalance})`,
      );
    }

    const payoutId = `dpk_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "DistributorPayout" ("id", "distributorId", "amount", "upiId", "accountHolder", "status", "adminNotes", "requestedAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'REQUESTED', $6, NOW(), NOW(), NOW())`,
      payoutId,
      distributorId,
      amount,
      cleanUpi,
      dto.accountHolder?.trim() || null,
      dto.notes?.trim() || null,
    );

    const payoutRows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "DistributorPayout" WHERE "id" = $1 LIMIT 1`,
      payoutId,
    );
    const payout = payoutRows[0];

    await this.audit.log({
      actorId: actorUser?.id,
      actorType: 'USER',
      action: 'DISTRIBUTOR_PAYOUT_REQUESTED',
      entity: 'DistributorPayout',
      entityId: payoutId,
      metadata: {
        distributorId,
        amount,
        upiId: cleanUpi,
      },
    });

    if (this.eventsGateway) {
      this.eventsGateway.emitToAdmins('admin:payout_requested', {
        payoutId,
        distributorId,
        distributorName: summary.distributor.name,
        amount,
        upiId: cleanUpi,
        timestamp: new Date().toISOString(),
      });
    }

    // Fire Telegram Bot notification for pending distributor payout in /admin/ledger
    if (this.notifications) {
      this.notifications
        .sendTelegramPaymentNotification({
          paymentType: 'DISTRIBUTOR_PAYOUT',
          amount,
          paymentReference: cleanUpi,
          applicantName: actorUser?.name || summary.distributor.name,
          entityName: summary.distributor.name,
          entityCode: (summary.distributor as any)?.distributorCode,
          district: (summary.distributor as any)?.district,
          mobile: actorUser?.mobile,
          email: actorUser?.email,
          role: 'DISTRIBUTOR',
        })
        .catch((err) => this.logger.error(`[Telegram Distributor Payout Notification] Error: ${err.message}`));
    }

    return {
      message: 'Payout request submitted successfully. Admin will process transfer and upload receipt.',
      payout,
    };
  }

  /**
   * Super Admin settles a distributor payout request
   */
  async settleDistributorPayout(
    payoutId: string,
    dto: { paymentReference: string; adminNotes?: string; screenshotUrl?: string },
    adminUser: any,
  ) {
    const payoutRows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "DistributorPayout" WHERE "id" = $1 LIMIT 1`,
      payoutId,
    );
    const payout = payoutRows[0];

    if (!payout) {
      throw new NotFoundException('Distributor payout not found');
    }

    let s3Screenshot = dto.screenshotUrl?.trim() || null;
    if (s3Screenshot && this.s3Storage) {
      try {
        const uploaded = await this.s3Storage.uploadProofImage(s3Screenshot, 'payouts/distributor');
        if (uploaded) s3Screenshot = uploaded;
      } catch (err: any) {
        this.logger.warn(`S3 upload skipped for distributor payout: ${err.message}`);
      }
    }

    await this.prisma.$executeRawUnsafe(
      `UPDATE "DistributorPayout" 
       SET "status" = 'SETTLED', 
           "paymentReference" = $1, 
           "adminNotes" = $2, 
           "screenshotUrl" = $3, 
           "settledAt" = NOW(), 
           "updatedAt" = NOW() 
       WHERE "id" = $4`,
      dto.paymentReference.trim(),
      dto.adminNotes?.trim() || payout.adminNotes,
      s3Screenshot,
      payoutId,
    );

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'USER',
      action: 'DISTRIBUTOR_PAYOUT_SETTLED',
      entity: 'DistributorPayout',
      entityId: payoutId,
      metadata: {
        distributorId: payout.distributorId,
        amount: Number(payout.amount),
        paymentReference: dto.paymentReference.trim(),
      },
    });

    if (this.eventsGateway) {
      this.eventsGateway.emitToAdmins('distributor:payout_settled', {
        payoutId,
        amount: Number(payout.amount),
        paymentReference: dto.paymentReference.trim(),
        timestamp: new Date().toISOString(),
      });
    }

    return { message: 'Distributor payout settled successfully' };
  }

  /**
   * Super Admin lists all distributor payouts
   */
  async getAllDistributorPayoutsAdmin(query: { status?: string }) {
    let sql = `
      SELECT p.*, d."name" as "distributorName", d."distributorCode", d."mobile" as "distributorMobile"
      FROM "DistributorPayout" p
      LEFT JOIN "Distributor" d ON d."id" = p."distributorId"
    `;

    if (query?.status && query.status !== 'ALL') {
      sql += ` WHERE p."status" = '${query.status.toUpperCase()}'`;
    }

    sql += ` ORDER BY p."createdAt" DESC`;

    const payouts = await this.prisma.$queryRawUnsafe<any[]>(sql);

    return {
      payouts: payouts.map((p) => ({
        id: p.id,
        distributorId: p.distributorId,
        distributorName: p.distributorName,
        distributorCode: p.distributorCode,
        distributorMobile: p.distributorMobile,
        amount: Number(p.amount),
        upiId: p.upiId,
        accountHolder: p.accountHolder,
        status: p.status,
        paymentReference: p.paymentReference,
        screenshotUrl: p.screenshotUrl,
        adminNotes: p.adminNotes,
        requestedAt: p.requestedAt,
        settledAt: p.settledAt,
        createdAt: p.createdAt,
      })),
    };
  }
}

