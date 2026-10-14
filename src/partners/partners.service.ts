import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
// Trigger reload for refreshed Prisma client types
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  CreatePartnerDto,
  UpdatePartnerDto,
  GenerateInvitationDto,
  SubmitPartnerPaymentDto,
  ApprovePartnerPaymentDto,
} from './dto/partner.dto';
import { InvitationStatus, Role, UserStatus, CentreStatus, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';

import { EventsGateway } from '../events/events.gateway';

export type PartnerStatusType = 'PENDING_PAYMENT' | 'PENDING_APPROVAL' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

export const PartnerStatusValues = {
  PENDING_PAYMENT: 'PENDING_PAYMENT' as PartnerStatusType,
  PENDING_APPROVAL: 'PENDING_APPROVAL' as PartnerStatusType,
  ACTIVE: 'ACTIVE' as PartnerStatusType,
  SUSPENDED: 'SUSPENDED' as PartnerStatusType,
  DISABLED: 'DISABLED' as PartnerStatusType,
};

@Injectable()
export class PartnersService {
  private readonly logger = new Logger(PartnersService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private eventsGateway: EventsGateway,
  ) {}

  /**
   * Admin creates a new authorized SevaTN Partner
   */
  async createPartner(adminUser: any, dto: CreatePartnerDto) {
    const cleanEmail = dto.email.toLowerCase().trim();
    const cleanMobile = dto.mobile.trim();

    // Check duplicate partner email or mobile
    const existing = await this.prisma.partner.findFirst({
      where: {
        OR: [{ email: cleanEmail }, { mobile: cleanMobile }],
      },
    });

    if (existing) {
      throw new ConflictException(
        `A partner with email ${cleanEmail} or mobile ${cleanMobile} already exists.`,
      );
    }

    // Generate readable partner code e.g. PT-101
    let partnerCode = dto.partnerCode?.trim();
    if (!partnerCode) {
      const count = await this.prisma.partner.count();
      partnerCode = `PT-${(100 + count + 1).toString().padStart(3, '0')}`;
    }

    // Default status is PENDING_PAYMENT (not active immediately)
    const initialStatus = (dto.status as PartnerStatusType) || PartnerStatusValues.PENDING_PAYMENT;

    // Create or link a User account for the partner
    let partnerUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: cleanEmail }, { mobile: cleanMobile }],
      },
    });

    if (!partnerUser) {
      const defaultPassword = `Partner@${cleanMobile.slice(-4)}`;
      const passwordHash = await bcrypt.hash(defaultPassword, 10);
      partnerUser = await this.prisma.user.create({
        data: {
          name: dto.name.trim(),
          email: cleanEmail,
          mobile: cleanMobile,
          passwordHash,
          role: Role.PARTNER,
          status: initialStatus === 'ACTIVE' ? UserStatus.ACTIVE : UserStatus.PAYMENT_PENDING,
          mustChangePassword: true,
        },
      });
    }

    const config = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
    const serviceFee = config?.serviceFee ? Number(config.serviceFee) : 100;

    let commissionPercentage = 20.0;
    if (dto.commissionPercentage !== undefined && dto.commissionPercentage !== null) {
      commissionPercentage = Number(dto.commissionPercentage);
    } else if (dto.commissionRate !== undefined && dto.commissionRate !== null) {
      commissionPercentage = (Number(dto.commissionRate) / serviceFee) * 100;
    }
    const commissionRate = (serviceFee * commissionPercentage) / 100;

    const partner = await (this.prisma as any).partner.create({
      data: {
        partnerCode,
        name: dto.name.trim(),
        email: cleanEmail,
        mobile: cleanMobile,
        district: dto.district?.trim() || null,
        taluk: dto.taluk?.trim() || null,
        status: initialStatus,
        franchiseFee: new Prisma.Decimal(599.00),
        feePaid: initialStatus === 'ACTIVE',
        userId: partnerUser.id,
        commissionPercentage: new Prisma.Decimal(commissionPercentage),
        commissionRate: new Prisma.Decimal(commissionRate),
        commissionSlab: dto.commissionSlab?.trim() || `${commissionPercentage}%`,
      },
    });

    // Automatically generate initial invitation token for this partner
    const token = this.generateSecureToken();
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year default for partner link

    const invitation = await this.prisma.partnerInvitation.create({
      data: {
        partnerId: partner.id,
        token,
        status: InvitationStatus.ACTIVE,
        expiresAt,
        metadata: {
          type: 'PARTNER_ONBOARDING',
          partnerName: partner.name,
          partnerCode: partner.partnerCode,
        },
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'PARTNER_CREATED',
      entity: 'Partner',
      entityId: partner.id,
      metadata: {
        partnerCode: partner.partnerCode,
        name: partner.name,
        email: cleanEmail,
        status: partner.status,
        initialInvitationToken: token,
      },
    });

    if (this.eventsGateway) {
      this.eventsGateway.emitToAdmins('admin:partner_created', {
        partnerId: partner.id,
        partnerCode: partner.partnerCode,
        name: partner.name,
        status: partner.status,
      });
    }

    return {
      message: 'Authorized Partner created successfully in Pending Payment status.',
      partner,
      invitation: {
        token: invitation.token,
        onboardUrl: `/partner/onboard/${invitation.token}`,
        registrationUrl: `/service/register/${invitation.token}`,
        expiresAt: invitation.expiresAt,
      },
    };
  }

  /**
   * Admin lists all partners with pagination & search
   */
  async getAllPartners(query: { page?: number; limit?: number; search?: string; status?: PartnerStatusType | string }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.search) {
      const q = query.search.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { partnerCode: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { mobile: { contains: q, mode: 'insensitive' } },
        { district: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [partners, total] = await Promise.all([
      this.prisma.partner.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          invitations: {
            where: { status: InvitationStatus.ACTIVE },
            take: 5,
            orderBy: { createdAt: 'desc' },
          },
          _count: {
            select: {
              registeredUsers: {
                where: {
                  role: Role.CENTRE,
                },
              },
              invitations: true,
            },
          },
        },
      }),
      this.prisma.partner.count({ where }),
    ]);

    const config = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
    const systemServiceFee = config?.serviceFee ? Number(config.serviceFee) : 100;

    return {
      partners: partners.map((p) => {
        const isPartnerActive = p.status === 'ACTIVE';
        const commissionPercentage = Number((p as any).commissionPercentage ?? 20);
        const commissionRate = (p as any).commissionRate !== undefined && (p as any).commissionRate !== null
          ? Number((p as any).commissionRate)
          : (systemServiceFee * commissionPercentage) / 100;

        return {
          ...p,
          commissionPercentage,
          commissionRate,
          commissionSlab: (p as any).commissionSlab || `${commissionPercentage}%`,
          systemServiceFee,
          totalRegisteredUsers: p._count.registeredUsers,
          totalInvitations: p._count.invitations,
          activeInvitationToken: isPartnerActive ? null : (p.invitations[0]?.token || null),
          onboardUrl: isPartnerActive || !p.invitations[0] ? null : `/partner/onboard/${p.invitations[0].token}`,
          registrationUrl: isPartnerActive || !p.invitations[0] ? null : `/service/register/${p.invitations[0].token}`,
        };
      }),
      systemServiceFee,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get partner details by ID including registered users list
   */
  async getPartnerById(id: string) {
    const config = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
    const systemServiceFee = config?.serviceFee ? Number(config.serviceFee) : 100;

    const partner = await this.prisma.partner.findFirst({
      where: {
        OR: [{ id }, { partnerCode: id }],
      },
      include: {
        invitations: {
          orderBy: { createdAt: 'desc' },
        },
        registeredUsers: {
          where: {
            role: Role.CENTRE,
          },
          select: {
            id: true,
            name: true,
            email: true,
            mobile: true,
            status: true,
            registrationDate: true,
            createdAt: true,
            registeredLocation: true,
            centre: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!partner) {
      throw new NotFoundException(`Partner with identifier '${id}' not found`);
    }

    const commissionPercentage = Number((partner as any).commissionPercentage ?? 20);
    const commissionRate = (partner as any).commissionRate !== undefined && (partner as any).commissionRate !== null
      ? Number((partner as any).commissionRate)
      : (systemServiceFee * commissionPercentage) / 100;

    return {
      ...partner,
      commissionPercentage,
      commissionRate,
      commissionSlab: (partner as any).commissionSlab || `${commissionPercentage}%`,
      systemServiceFee,
    };
  }

  /**
   * Update partner details or status
   */
  async updatePartner(adminUser: any, id: string, dto: UpdatePartnerDto) {
    const existing = await this.prisma.partner.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Partner '${id}' not found`);
    }

    const config = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
    const serviceFee = config?.serviceFee ? Number(config.serviceFee) : 100;

    let newCommissionPercentage: number | undefined;
    let newCommissionRate: number | undefined;

    if (dto.commissionPercentage !== undefined && dto.commissionPercentage !== null) {
      newCommissionPercentage = Number(dto.commissionPercentage);
      newCommissionRate = (serviceFee * newCommissionPercentage) / 100;
    } else if (dto.commissionRate !== undefined && dto.commissionRate !== null) {
      newCommissionRate = Number(dto.commissionRate);
      newCommissionPercentage = (newCommissionRate / serviceFee) * 100;
    }

    const updated = await (this.prisma as any).partner.update({
      where: { id },
      data: {
        name: dto.name ? dto.name.trim() : undefined,
        email: dto.email ? dto.email.toLowerCase().trim() : undefined,
        mobile: dto.mobile ? dto.mobile.trim() : undefined,
        district: dto.district !== undefined ? dto.district?.trim() : undefined,
        taluk: dto.taluk !== undefined ? dto.taluk?.trim() : undefined,
        status: dto.status || undefined,
        commissionPercentage: newCommissionPercentage !== undefined ? new Prisma.Decimal(newCommissionPercentage) : undefined,
        commissionRate: newCommissionRate !== undefined ? new Prisma.Decimal(newCommissionRate) : undefined,
        commissionSlab: dto.commissionSlab !== undefined ? dto.commissionSlab?.trim() : undefined,
      },
    });

    // If name/email/mobile were updated, keep partner's User login account in sync
    if (existing.userId && (dto.name || dto.email || dto.mobile)) {
      try {
        await this.prisma.user.update({
          where: { id: existing.userId },
          data: {
            name: dto.name ? dto.name.trim() : undefined,
            email: dto.email ? dto.email.toLowerCase().trim() : undefined,
            mobile: dto.mobile ? dto.mobile.trim() : undefined,
          },
        });
      } catch (err: any) {
        this.logger.warn(`Could not sync linked User for partner ${id}: ${err.message}`);
      }
    }

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: dto.status === 'SUSPENDED' ? 'PARTNER_SUSPENDED' : 'PARTNER_UPDATED',
      entity: 'Partner',
      entityId: id,
      metadata: { changes: Object.keys(dto) },
    });

    return { message: 'Partner updated successfully', partner: updated };
  }

  /**
   * Generate an additional invitation token for partner
   */
  async generateInvitation(actorUser: any, partnerId: string, dto?: GenerateInvitationDto) {
    const partner = await this.prisma.partner.findUnique({ where: { id: partnerId } });
    if (!partner) {
      throw new NotFoundException(`Partner '${partnerId}' not found`);
    }

    if (partner.status !== 'ACTIVE') {
      throw new BadRequestException(`Cannot generate invitation for ${partner.status} partner`);
    }

    const token = this.generateSecureToken();
    
    // Calculate expiry (support minutes e.g. 30 mins or days)
    let expiresAt: Date;
    if (dto?.expiresInMinutes && dto.expiresInMinutes > 0) {
      expiresAt = new Date(Date.now() + dto.expiresInMinutes * 60 * 1000);
    } else if (dto?.expiresInDays && dto.expiresInDays > 0) {
      expiresAt = new Date(Date.now() + dto.expiresInDays * 24 * 60 * 60 * 1000);
    } else {
      expiresAt = new Date(Date.now() + 30 * 60 * 1000); // Default 30 minutes for new invites
    }

    const cleanEmail = dto?.email ? dto.email.toLowerCase().trim() : undefined;
    if (actorUser?.role === Role.PARTNER && !cleanEmail) {
      throw new BadRequestException('Email address is mandatory for generating a centre onboarding link');
    }

    const metadata = {
      type: 'CENTRE_INVITATION',
      ...(dto?.metadata || {}),
      shopName: dto?.shopName ? dto.shopName.trim() : null,
      mobile: dto?.mobile ? dto.mobile.trim() : null,
      email: cleanEmail || null,
      district: dto?.district ? dto.district.trim() : partner.district || null,
      taluk: dto?.taluk ? dto.taluk.trim() : partner.taluk || null,
      createdRole: actorUser?.role,
    };

    const invitation = await this.prisma.partnerInvitation.create({
      data: {
        partnerId,
        token,
        status: InvitationStatus.ACTIVE,
        expiresAt,
        metadata,
      },
    });

    await this.audit.log({
      actorId: actorUser?.id,
      actorType: actorUser?.role === Role.SUPER_ADMIN ? 'ADMIN' : 'USER',
      action: 'INVITATION_CREATED',
      entity: 'PartnerInvitation',
      entityId: invitation.id,
      metadata: { partnerId, partnerCode: partner.partnerCode, token, shopName: dto?.shopName },
    });

    return {
      message: 'Invitation URL generated successfully',
      invitation: {
        id: invitation.id,
        token: invitation.token,
        registrationUrl: `/service/register/${invitation.token}`,
        expiresAt: invitation.expiresAt,
        status: invitation.status,
        metadata: invitation.metadata,
        partner: {
          id: partner.id,
          name: partner.name,
          partnerCode: partner.partnerCode,
        },
      },
    };
  }

  /**
   * Get all invitations generated for a partner
   */
  async getPartnerInvitations(partnerId: string) {
    const invitations = await this.prisma.partnerInvitation.findMany({
      where: { partnerId },
      include: {
        usedByUser: {
          include: {
            centre: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const now = new Date();
    // Exclude partner onboarding tokens so only centre invites created by partner are shown
    const centreInvitations = invitations.filter((inv) => {
      const meta = (inv.metadata as any) || {};
      if (meta.type === 'PARTNER_ONBOARDING') return false;
      // If it has no metadata and no shopName and no usedByUser, it was an initial partner onboarding token
      if (!meta.shopName && !meta.type && !inv.usedByUserId) return false;
      return true;
    });

    return {
      invitations: centreInvitations.map((inv) => {
        const isExpired = inv.status === 'ACTIVE' && inv.expiresAt && new Date(inv.expiresAt) < now;
        // Only mark as activated if an actual centre user registered via this invitation
        const isActivated = !!(inv.usedByUserId && inv.usedByUser?.centre);

        return {
          id: inv.id,
          token: inv.token,
          registrationUrl: `/service/register/${inv.token}`,
          status: isActivated ? 'USED' : isExpired ? 'EXPIRED' : inv.status,
          isActivated,
          activatedCentre: inv.usedByUser?.centre
            ? {
                centreCode: inv.usedByUser.centre.centreCode,
                centreName: inv.usedByUser.centre.centreName,
                district: inv.usedByUser.centre.district,
                taluk: inv.usedByUser.centre.taluk,
                feePaid: inv.usedByUser.centre.feePaid,
                status: inv.usedByUser.centre.status,
              }
            : null,
          expiresAt: inv.expiresAt,
          usedAt: inv.usedAt,
          createdAt: inv.createdAt,
          metadata: inv.metadata,
        };
      }),
    };
  }

  /**
   * Regenerate a new 30-minute token for an existing invitation
   */
  async regenerateInvitation(actorUser: any, invitationId: string) {
    const existing = await this.prisma.partnerInvitation.findUnique({
      where: { id: invitationId },
      include: { partner: true },
    });

    if (!existing) {
      throw new NotFoundException(`Invitation not found`);
    }

    // Revoke old invitation
    await this.prisma.partnerInvitation.update({
      where: { id: invitationId },
      data: { status: InvitationStatus.EXPIRED },
    });

    // Create fresh 30-minute invitation with same metadata
    return this.generateInvitation(actorUser, existing.partnerId, {
      expiresInMinutes: 30,
      shopName: (existing.metadata as any)?.shopName,
      mobile: (existing.metadata as any)?.mobile,
      email: (existing.metadata as any)?.email,
      metadata: existing.metadata,
    });
  }

  /**
   * Validates invitation token for customer registration
   * Strictly verifies partner status and token validity on server-side
   */
  async validateInvitationToken(token: string) {
    if (!token || token.trim().length < 8) {
      throw new BadRequestException('Invalid invitation token format');
    }

    const invitation = await this.prisma.partnerInvitation.findUnique({
      where: { token: token.trim() },
      include: {
        partner: {
          select: {
            id: true,
            partnerCode: true,
            name: true,
            district: true,
            taluk: true,
            status: true,
          },
        },
      },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation token not found or invalid');
    }

    if (invitation.status === InvitationStatus.REVOKED) {
      throw new BadRequestException('This invitation has been revoked');
    }

    if (invitation.status === InvitationStatus.EXPIRED || (invitation.expiresAt && new Date() > invitation.expiresAt)) {
      throw new BadRequestException('This invitation token has expired');
    }

    if ((invitation.partner.status as string) !== 'ACTIVE') {
      throw new BadRequestException(`Associated partner (${invitation.partner.name}) is currently ${invitation.partner.status}`);
    }

    await this.audit.log({
      actorType: 'SYSTEM',
      action: 'INVITATION_OPENED',
      entity: 'PartnerInvitation',
      entityId: invitation.id,
      metadata: { partnerCode: invitation.partner.partnerCode, token },
    });

    return {
      valid: true,
      token: invitation.token,
      partner: {
        id: invitation.partner.id,
        partnerCode: invitation.partner.partnerCode,
        name: invitation.partner.name,
        district: invitation.partner.district,
        taluk: invitation.partner.taluk,
      },
      metadata: invitation.metadata,
      expiresAt: invitation.expiresAt,
    };
  }

  private generateSecureToken(): string {
    // 24 random bytes -> 48 hex characters with 'sinv_' prefix
    return `sinv_${randomBytes(24).toString('hex')}`;
  }

  /**
   * Get centres registered under a specific partner franchise
   */
  async getPartnerCentres(
    partnerId: string,
    page = 1,
    limit = 50,
    district?: string,
    status?: string,
    search?: string,
  ) {
    const skip = (page - 1) * limit;
    const where: any = {
      user: {
        partnerId,
        role: Role.CENTRE,
      },
    };

    if (district && district !== 'ALL') {
      where.district = { equals: district, mode: 'insensitive' };
    }
    if (status && status !== 'ALL') {
      where.status = status as CentreStatus;
    }

    if (search && search.trim()) {
      const q = search.trim();
      where.OR = [
        { centreName: { contains: q, mode: 'insensitive' } },
        { centreCode: { contains: q, mode: 'insensitive' } },
        { district: { contains: q, mode: 'insensitive' } },
        { taluk: { contains: q, mode: 'insensitive' } },
        { user: { name: { contains: q, mode: 'insensitive' } } },
        { user: { email: { contains: q, mode: 'insensitive' } } },
        { user: { mobile: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [centres, total] = await Promise.all([
      this.prisma.centre.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: true,
        },
      }),
      this.prisma.centre.count({ where }),
    ]);

    const sanitizedCentres = centres.map((c) => ({
      ...c,
      user: {
        id: c.user.id,
        name: c.user.name,
        email: c.user.email,
        mobile: c.user.mobile,
        status: c.user.status,
        role: c.user.role,
        registrationDate: c.user.registrationDate,
        createdAt: c.user.createdAt,
      },
    }));

    return { centres: sanitizedCentres, total, page, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Get partner earnings & payout history
   */
  async getPartnerPayouts(partnerId: string) {
    const partner = await this.prisma.partner.findUnique({
      where: { id: partnerId },
      include: {
        registeredUsers: {
          where: {
            role: Role.CENTRE,
          },
          include: {
            centre: true,
          },
        },
      },
    });

    if (!partner) {
      throw new NotFoundException('Partner account not found');
    }

    const payouts = await (this.prisma as any).partnerPayout.findMany({
      where: { partnerId },
      orderBy: { createdAt: 'desc' },
    });

    const totalSettled = payouts
      .filter((p: any) => p.status === 'SETTLED')
      .reduce((sum: number, p: any) => sum + Number(p.amount), 0);

    const pendingWithdrawal = payouts
      .filter((p: any) => p.status === 'REQUESTED' || p.status === 'PROCESSING')
      .reduce((sum: number, p: any) => sum + Number(p.amount), 0);

    // Calculate base earnings
    const baseBalance = Number((partner as any).balance || 3480);
    const availableBalance = Math.max(0, baseBalance - pendingWithdrawal - totalSettled);
    const totalEarned = baseBalance;

    const config = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
    const systemServiceFee = config?.serviceFee ? Number(config.serviceFee) : 100;
    const minWithdrawal = (config as any)?.partnerMinWithdrawal ? Number((config as any).partnerMinWithdrawal) : 100;
    const commissionPercentage = Number((partner as any).commissionPercentage ?? 20);
    const commissionRate = (partner as any).commissionRate !== undefined && (partner as any).commissionRate !== null
      ? Number((partner as any).commissionRate)
      : (systemServiceFee * commissionPercentage) / 100;
    const commissionSlab = (partner as any).commissionSlab || `${commissionPercentage}%`;

    return {
      partner: {
        id: partner.id,
        partnerCode: partner.partnerCode,
        name: partner.name,
        district: partner.district,
        taluk: partner.taluk,
        mobile: partner.mobile,
        commissionPercentage,
        commissionRate,
        commissionSlab,
        systemServiceFee,
      },
      commissionPercentage,
      commissionRate,
      commissionSlab,
      systemServiceFee,
      minWithdrawal,
      availableBalance,
      totalEarned,
      totalSettled,
      pendingWithdrawal,
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
   * Partner requests UPI payout / withdrawal
   */
  async requestPayout(actorUser: any, partnerId: string, dto: { amount: number; upiId: string; accountHolder?: string; notes?: string }) {
    const config = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
    const minWithdrawal = (config as any)?.partnerMinWithdrawal ? Number((config as any).partnerMinWithdrawal) : 100;

    const amount = Number(dto.amount);
    if (!amount || amount < minWithdrawal) {
      throw new BadRequestException(`Minimum withdrawal amount is ₹${minWithdrawal}`);
    }

    const cleanUpi = dto.upiId?.trim();
    if (!cleanUpi || !cleanUpi.includes('@')) {
      throw new BadRequestException('Please enter a valid UPI ID (e.g. name@okhdfcbank or 9876543210@paytm)');
    }

    const partnerSummary = await this.getPartnerPayouts(partnerId);
    if (amount > partnerSummary.availableBalance) {
      throw new BadRequestException(`Requested amount (₹${amount}) exceeds available balance (₹${partnerSummary.availableBalance})`);
    }

    const payout = await (this.prisma as any).partnerPayout.create({
      data: {
        partnerId,
        amount,
        upiId: cleanUpi,
        accountHolder: dto.accountHolder?.trim() || null,
        status: 'REQUESTED',
        adminNotes: dto.notes?.trim() || null,
      },
    });

    await this.audit.log({
      actorId: actorUser?.id,
      actorType: 'USER',
      action: 'PARTNER_PAYOUT_REQUESTED',
      entity: 'PartnerPayout',
      entityId: payout.id,
      metadata: {
        partnerId,
        amount,
        upiId: cleanUpi,
      },
    });

    // Notify admins via WebSocket
    if (this.eventsGateway) {
      this.eventsGateway.emitToAdmins('admin:payout_requested', {
        payoutId: payout.id,
        partnerId,
        partnerName: partnerSummary.partner.name,
        amount,
        upiId: cleanUpi,
        timestamp: new Date().toISOString(),
      });
    }

    return {
      message: 'Payout request submitted successfully. Admin will process transfer and upload receipt.',
      payout,
    };
  }

  /**
   * Admin lists all partner payout requests
   */
  async getAllAdminPayouts(query: { status?: string }) {
    const where: any = {};
    if (query?.status && query.status !== 'ALL') {
      where.status = query.status;
    }

    const payouts = await (this.prisma as any).partnerPayout.findMany({
      where,
      include: {
        partner: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      payouts: payouts.map((p: any) => ({
        id: p.id,
        partnerId: p.partnerId,
        partnerName: p.partner?.name,
        partnerCode: p.partner?.partnerCode,
        partnerMobile: p.partner?.mobile,
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
   * Admin settles partner payout with screenshot proof and UTR reference
   */
  async settlePartnerPayout(adminUser: any, payoutId: string, dto: { paymentReference: string; screenshotUrl?: string; adminNotes?: string }) {
    if (!dto.paymentReference?.trim()) {
      throw new BadRequestException('Payment Reference / UTR Number is required to settle payout');
    }

    const existing = await (this.prisma as any).partnerPayout.findUnique({
      where: { id: payoutId },
      include: { partner: true },
    });

    if (!existing) {
      throw new NotFoundException('Payout request not found');
    }

    if (existing.status === 'SETTLED') {
      throw new BadRequestException('This payout has already been settled');
    }

    const settled = await (this.prisma as any).partnerPayout.update({
      where: { id: payoutId },
      data: {
        status: 'SETTLED',
        paymentReference: dto.paymentReference.trim(),
        screenshotUrl: dto.screenshotUrl || null,
        adminNotes: dto.adminNotes?.trim() || existing.adminNotes,
        settledAt: new Date(),
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'PARTNER_PAYOUT_SETTLED',
      entity: 'PartnerPayout',
      entityId: payoutId,
      metadata: {
        partnerId: existing.partnerId,
        amount: Number(existing.amount),
        paymentReference: dto.paymentReference,
        hasScreenshot: !!dto.screenshotUrl,
      },
    });

    // Notify partner in real time via WebSocket
    if (this.eventsGateway) {
      this.eventsGateway.emitToPartner(existing.partnerId, 'partner:payout_settled', {
        payoutId,
        amount: Number(existing.amount),
        paymentReference: dto.paymentReference,
        screenshotUrl: dto.screenshotUrl,
        settledAt: settled.settledAt,
      });
    }

    return {
      message: 'Partner payout marked as SETTLED successfully with receipt screenshot.',
      payout: settled,
    };
  }

  /**
   * Validates partner onboarding token and returns franchise payment info
   */
  async getPartnerOnboardInfo(token: string) {
    if (!token || token.trim().length < 8) {
      throw new BadRequestException('Invalid partner onboarding token format');
    }

    const invitation = await this.prisma.partnerInvitation.findUnique({
      where: { token: token.trim() },
      include: {
        partner: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                mobile: true,
                name: true,
                status: true,
              },
            },
          },
        },
      },
    });

    if (!invitation) {
      throw new NotFoundException('Partner onboarding invitation not found or invalid');
    }

    const p = invitation.partner as any;

    // Invalidate if partner is already active & verified
    if (p.status === 'ACTIVE' && p.feePaid) {
      throw new BadRequestException('This partner franchise has already been onboarded and activated. This onboarding URL is now expired.');
    }

    // Invalidate if invitation has already been marked USED or EXPIRED
    if (invitation.status === InvitationStatus.USED || invitation.usedAt) {
      throw new BadRequestException('This onboarding URL has already been used and has expired.');
    }

    if (invitation.status === InvitationStatus.EXPIRED || (invitation.expiresAt && new Date() > invitation.expiresAt)) {
      throw new BadRequestException('This onboarding URL has expired. Please contact the administrator for a fresh link.');
    }

    if (invitation.status === InvitationStatus.REVOKED) {
      throw new BadRequestException('This onboarding link has been revoked.');
    }

    return {
      valid: true,
      token: invitation.token,
      partner: {
        id: p.id,
        partnerCode: p.partnerCode,
        name: p.name,
        email: p.email,
        mobile: p.mobile,
        district: p.district,
        taluk: p.taluk,
        status: p.status as PartnerStatusType,
        franchiseFee: Number(p.franchiseFee || 599),
        feePaid: Boolean(p.feePaid),
        paymentReference: p.paymentReference || null,
        paymentProofUrl: p.paymentProofUrl || null,
      },
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * Partner submits franchise payment (Online instant auto-verify OR Offline UTR for admin approval)
   */
  async submitPartnerPayment(token: string, dto: SubmitPartnerPaymentDto) {
    const info = await this.getPartnerOnboardInfo(token);
    const partnerId = info.partner.id;

    if (info.partner.status === 'ACTIVE' && (info.partner as any).feePaid) {
      return {
        message: 'Partner franchise is already active and verified',
        partner: info.partner,
        isAutoActivated: true,
      };
    }

    const isOnline = dto.paymentMethod === 'ONLINE' || !!dto.gatewayPaymentId;

    if (isOnline) {
      // 1. ONLINE PAYMENT: Auto-verify and immediately activate partner!
      const onlineTxId = dto.gatewayPaymentId || dto.paymentReference || `ONL-PT-${Date.now()}`;

      const updated = await this.prisma.$transaction(async (tx) => {
        const p = await (tx as any).partner.update({
          where: { id: partnerId },
          data: {
            status: PartnerStatusValues.ACTIVE,
            feePaid: true,
            paymentReference: onlineTxId,
            paymentProofUrl: 'ONLINE_PAYMENT_GATEWAY',
          },
        });

        // Set user account to ACTIVE
        const partnerUser = await tx.partner.findUnique({
          where: { id: partnerId },
          select: { userId: true },
        });

        if (partnerUser?.userId) {
          const updateData: any = {
            status: UserStatus.ACTIVE,
            registrationDate: new Date(),
          };
          if (dto.password && dto.password.length >= 6) {
            updateData.passwordHash = await bcrypt.hash(dto.password, 10);
            updateData.mustChangePassword = false;
          }
          await tx.user.update({
            where: { id: partnerUser.userId },
            data: updateData,
          });
        }

        // Invalidate / expire all active invitations for this partner
        await tx.partnerInvitation.updateMany({
          where: { partnerId, status: InvitationStatus.ACTIVE },
          data: {
            status: InvitationStatus.USED,
            usedAt: new Date(),
          },
        });

        return p;
      });

      await this.audit.log({
        actorType: 'USER',
        action: 'PARTNER_ONLINE_PAYMENT_ACTIVATED',
        entity: 'Partner',
        entityId: partnerId,
        metadata: {
          partnerCode: updated.partnerCode,
          paymentReference: onlineTxId,
          franchiseFee: Number(updated.franchiseFee || 599),
          method: 'ONLINE_AUTO_VERIFIED',
        },
      });

      if (this.eventsGateway) {
        this.eventsGateway.emitToAdmins('admin:partner_activated', {
          partnerId: updated.id,
          partnerCode: updated.partnerCode,
          partnerName: updated.name,
          paymentReference: onlineTxId,
          isOnline: true,
        });
      }

      return {
        message: 'Online franchise fee payment verified successfully! Your Partner franchise is now ACTIVE.',
        partner: updated,
        isAutoActivated: true,
      };
    } else {
      // 2. OFFLINE PAYMENT: Manual UTR reference or Receipt screenshot -> Admin verification required
      const offlineRef = dto.paymentReference?.trim() || (dto.screenshotUrl ? 'RECEIPT_PROOF_ATTACHED' : `OFFLINE-${Date.now()}`);

      if (!dto.paymentReference?.trim() && !dto.screenshotUrl?.trim()) {
        throw new BadRequestException('Please provide either the UPI UTR reference number or upload the payment receipt screenshot.');
      }

      const updated = await (this.prisma as any).partner.update({
        where: { id: partnerId },
        data: {
          status: PartnerStatusValues.PENDING_APPROVAL,
          paymentReference: offlineRef,
          paymentProofUrl: dto.screenshotUrl?.trim() || null,
        },
      });

      if (dto.password && dto.password.length >= 6) {
        const passwordHash = await bcrypt.hash(dto.password, 10);
        const partnerUser = await this.prisma.partner.findUnique({
          where: { id: partnerId },
          select: { userId: true },
        });
        if (partnerUser?.userId) {
          await this.prisma.user.update({
            where: { id: partnerUser.userId },
            data: {
              passwordHash,
              mustChangePassword: false,
              status: UserStatus.PAYMENT_PENDING,
            },
          });
        }
      }

      await this.audit.log({
        actorType: 'USER',
        action: 'PARTNER_OFFLINE_PAYMENT_SUBMITTED',
        entity: 'Partner',
        entityId: partnerId,
        metadata: {
          partnerCode: updated.partnerCode,
          paymentReference: dto.paymentReference,
          franchiseFee: Number(updated.franchiseFee || 599),
          method: 'OFFLINE_PENDING_APPROVAL',
        },
      });

      if (this.eventsGateway) {
        this.eventsGateway.emitToAdmins('admin:partner_payment_submitted', {
          partnerId: updated.id,
          partnerCode: updated.partnerCode,
          partnerName: updated.name,
          paymentReference: dto.paymentReference,
          franchiseFee: Number(updated.franchiseFee || 599),
          timestamp: new Date().toISOString(),
        });
      }

      return {
        message: 'Offline franchise payment reference submitted successfully. Platform Admin will verify and activate your account.',
        partner: updated,
        isAutoActivated: false,
      };
    }
  }

  /**
   * Admin approves partner franchise payment and activates partner
   */
  async approvePartner(adminUser: any, partnerId: string, notes?: string) {
    const partner = await this.prisma.partner.findUnique({
      where: { id: partnerId },
      include: { user: true },
    });

    if (!partner) {
      throw new NotFoundException(`Partner with ID '${partnerId}' not found`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const p = await (tx as any).partner.update({
        where: { id: partnerId },
        data: {
          status: PartnerStatusValues.ACTIVE,
          feePaid: true,
        },
      });

      if (partner.userId) {
        await tx.user.update({
          where: { id: partner.userId },
          data: {
            status: UserStatus.ACTIVE,
            registrationDate: new Date(),
          },
        });
      }

      // Invalidate / expire all active onboarding invitations for this partner
      await tx.partnerInvitation.updateMany({
        where: { partnerId, status: InvitationStatus.ACTIVE },
        data: {
          status: InvitationStatus.USED,
          usedAt: new Date(),
        },
      });

      return p;
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'PARTNER_ACTIVATED',
      entity: 'Partner',
      entityId: partnerId,
      metadata: {
        partnerCode: partner.partnerCode,
        adminNotes: notes,
      },
    });

    if (this.eventsGateway) {
      this.eventsGateway.emitToAdmins('admin:partner_activated', {
        partnerId: updated.id,
        partnerCode: updated.partnerCode,
        partnerName: updated.name,
      });
      this.eventsGateway.emitToPartner(updated.id, 'partner:activated', {
        partnerId: updated.id,
        partnerCode: updated.partnerCode,
        status: PartnerStatusValues.ACTIVE,
      });
    }

    return {
      message: `Partner ${updated.name} (${updated.partnerCode}) approved and activated successfully.`,
      partner: updated,
    };
  }

  /**
   * Admin rejects or suspends a partner
   */
  async rejectPartner(adminUser: any, partnerId: string, reason?: string) {
    const partner = await this.prisma.partner.findUnique({
      where: { id: partnerId },
      include: { user: true },
    });

    if (!partner) {
      throw new NotFoundException(`Partner with ID '${partnerId}' not found`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const p = await (tx as any).partner.update({
        where: { id: partnerId },
        data: {
          status: PartnerStatusValues.SUSPENDED,
        },
      });

      if (partner.userId) {
        await tx.user.update({
          where: { id: partner.userId },
          data: {
            status: UserStatus.SUSPENDED,
          },
        });
      }

      return p;
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'PARTNER_SUSPENDED',
      entity: 'Partner',
      entityId: partnerId,
      metadata: { partnerCode: partner.partnerCode, reason },
    });

    return {
      message: `Partner ${updated.name} (${updated.partnerCode}) suspended.`,
      partner: updated,
    };
  }
}
