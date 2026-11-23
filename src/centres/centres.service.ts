import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EventsGateway } from '../events/events.gateway';
import { CreateCentreDto, UpdateCentreDto } from './dto/centre.dto';
import { Role, UserStatus, CentreStatus, TransactionType, TransactionStatus, Prisma } from '@prisma/client';
import { isValidCoordinate } from '../common/utils/geo';
import * as bcrypt from 'bcrypt';

@Injectable()
export class CentresService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    @Optional() private readonly eventsGateway?: EventsGateway,
  ) {}

  async getMyCentre(userId: string) {
    const centre = await this.prisma.centre.findUnique({
      where: { userId },
      include: {
        distributor: {
          select: {
            id: true,
            distributorCode: true,
            name: true,
            businessName: true,
            mobile: true,
            email: true,
            district: true,
          },
        },
        user: {
          include: {
            registeredLocation: true,
          },
        },
      },
    });

    if (!centre) {
      throw new NotFoundException('Centre profile not found');
    }

    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
    });

    return {
      ...centre,
      user: this.sanitizeUser(centre.user),
      wallet,
    };
  }

  async getAllCentres(page = 1, limit = 50, district?: string, status?: string, search?: string) {
    const skip = (page - 1) * limit;
    const where: any = {};

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
          user: {
            include: {
              registeredLocation: true,
              wallet: true,
            },
          },
        },
      }),
      this.prisma.centre.count({ where }),
    ]);

    const sanitizedCentres = centres.map((c) => ({
      ...c,
      user: this.sanitizeUser(c.user),
    }));

    return { centres: sanitizedCentres, total, page, totalPages: Math.ceil(total / limit) };
  }

  async getCentreById(id: string) {
    const centre = await this.prisma.centre.findFirst({
      where: {
        OR: [{ id }, { userId: id }, { centreCode: id }],
      },
      include: {
        user: {
          include: {
            registeredLocation: true,
          },
        },
      },
    });

    if (!centre) {
      throw new NotFoundException(`Centre with identifier '${id}' not found`);
    }

    const wallet = await this.prisma.wallet.findUnique({
      where: { userId: centre.userId },
    });

    const activeBookings = await this.prisma.bookingRequest.count({
      where: { userId: centre.userId, status: { in: ['QUEUED', 'ASSIGNED', 'WATCHING', 'BOOKING'] } },
    });

    return {
      ...centre,
      user: this.sanitizeUser(centre.user),
      wallet,
      activeBookings,
    };
  }

  async createCentre(actorUser: any, dto: CreateCentreDto) {
    const cleanEmail = dto.email.toLowerCase().trim();
    const cleanMobile = dto.mobile.trim();

    // 0. Resolve partnerId & distributorId based on actor role
    let partnerId: string | null = null;
    let distributorId: string | null = null;

    if (actorUser.role === Role.DISTRIBUTOR) {
      const orConditions: any[] = [{ userId: actorUser.id }];
      if (actorUser.distributorId) {
        orConditions.push({ id: actorUser.distributorId });
      }
      if (actorUser.distributorProfile?.id) {
        orConditions.push({ id: actorUser.distributorProfile.id });
      }
      const distProfile = await this.prisma.distributor.findFirst({
        where: { OR: orConditions },
      });
      if (!distProfile || distProfile.status !== 'ACTIVE') {
        throw new ForbiddenException('Only active Distributors can create Centre accounts.');
      }
      distributorId = distProfile.id;
      partnerId = distProfile.partnerId;
    } else if (actorUser.role === Role.PARTNER) {
      const orConditions: any[] = [{ userId: actorUser.id }];
      if (actorUser.partnerId) {
        orConditions.push({ id: actorUser.partnerId });
      }
      if (actorUser.partnerProfile?.id) {
        orConditions.push({ id: actorUser.partnerProfile.id });
      }
      const partnerProfile = await this.prisma.partner.findFirst({
        where: { OR: orConditions },
      });
      if (!partnerProfile || partnerProfile.status !== 'ACTIVE') {
        throw new ForbiddenException('Only active Partners can create Centre accounts.');
      }
      partnerId = partnerProfile.id;
      if (dto.distributorId && dto.distributorId.trim() !== '') {
        const dist = await this.prisma.distributor.findFirst({
          where: { id: dto.distributorId.trim(), partnerId: partnerProfile.id },
        });
        if (dist) distributorId = dist.id;
      }
    } else if (actorUser.role === Role.SUPER_ADMIN) {
      partnerId = dto.partnerId?.trim() || null;
      distributorId = dto.distributorId?.trim() || null;
    }

    // 1. Verify User uniqueness (Email / Mobile)
    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: cleanEmail }, { mobile: cleanMobile }],
      },
    });

    if (existingUser) {
      throw new ConflictException(
        `A user account with this email (${cleanEmail}) or mobile (${cleanMobile}) already exists.`,
      );
    }

    // 2. Check or generate unique Centre Code
    let centreCode = dto.centreCode?.trim();
    if (centreCode) {
      const existingCentreCode = await this.prisma.centre.findUnique({
        where: { centreCode },
      });
      if (existingCentreCode) {
        throw new ConflictException(`Centre Code '${centreCode}' is already assigned to another centre.`);
      }
    } else {
      centreCode = await this.generateUniqueCentreCode(dto.district);
    }

    // 3. Generate Temporary Password
    const temporaryPassword = dto.temporaryPassword || this.generateTemporaryPassword();
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(temporaryPassword, saltRounds);

    // 4. Compute Registration & Expiry Dates
    const registrationDate = new Date();
    let expiryDate: Date;
    if (dto.expiryDate) {
      expiryDate = new Date(dto.expiryDate);
    } else {
      const days = dto.validityDays && dto.validityDays > 0 ? dto.validityDays : 45;
      expiryDate = new Date(registrationDate.getTime() + days * 24 * 60 * 60 * 1000);
    }

    const initialStatus = dto.status || CentreStatus.ACTIVE;
    const userInitialStatus =
      initialStatus === CentreStatus.SUSPENDED ? UserStatus.SUSPENDED : UserStatus.ACTIVE;

    // Resolve Centre Onboarding Fee from SystemConfig
    const sysConfig = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
    const centreFeeAmount = Number(sysConfig?.registrationFee || 249);

    // If created by Partner or Distributor, check wallet balance
    let payerUserId: string | null = null;
    let payerRoleName = '';
    if (actorUser.role === Role.PARTNER) {
      payerUserId = actorUser.id;
      payerRoleName = 'Partner';
    } else if (actorUser.role === Role.DISTRIBUTOR) {
      payerUserId = actorUser.id;
      payerRoleName = 'Distributor';
    }

    if (payerUserId) {
      const payerWallet = await this.prisma.wallet.findUnique({ where: { userId: payerUserId } });
      const currentAvailable = Number(payerWallet?.availableBalance || 0);
      if (currentAvailable < centreFeeAmount) {
        throw new BadRequestException(
          `Insufficient ${payerRoleName} Wallet Balance: Your available balance is ₹${currentAvailable.toFixed(2)}, but the Centre Onboarding Fee is ₹${centreFeeAmount.toFixed(2)}. Please recharge your wallet to proceed with onboarding.`,
        );
      }
    }

    // 5. Execute Transactional Creation
    const result = await this.prisma.$transaction(async (tx) => {
      // Deduct Centre Onboarding Fee from Partner's or Distributor's Wallet if creator is Partner/Distributor
      let payerWalletUpdated: any = null;
      if (payerUserId) {
        let pWallet = await tx.wallet.findUnique({ where: { userId: payerUserId } });
        if (!pWallet) {
          pWallet = await tx.wallet.create({
            data: {
              userId: payerUserId,
              availableBalance: new Prisma.Decimal(0),
              reservedBalance: new Prisma.Decimal(0),
            },
          });
        }
        const prevBal = Number(pWallet.availableBalance);
        if (prevBal < centreFeeAmount) {
          throw new BadRequestException(
            `Insufficient ${payerRoleName} Wallet Balance: Your available balance is ₹${prevBal.toFixed(2)}, but the Centre Onboarding Fee is ₹${centreFeeAmount.toFixed(2)}. Please recharge your wallet.`,
          );
        }
        const newBal = prevBal - centreFeeAmount;
        payerWalletUpdated = await tx.wallet.update({
          where: { id: pWallet.id },
          data: { availableBalance: new Prisma.Decimal(newBal) },
        });

        await tx.walletTransaction.create({
          data: {
            walletId: pWallet.id,
            userId: payerUserId,
            type: TransactionType.ADJUSTMENT,
            amount: new Prisma.Decimal(-centreFeeAmount),
            status: TransactionStatus.COMPLETED,
            reference: `CTR-FEE-${centreCode}`,
            metadata: {
              description: `Centre Onboarding Fee for ${dto.centreName.trim()} (${centreCode})`,
              centreCode,
              centreName: dto.centreName.trim(),
              feeAmount: centreFeeAmount,
              previousBalance: prevBal,
              newBalance: newBal,
              payerRole: payerRoleName,
            },
          },
        });
      }

      const user = await tx.user.create({
        data: {
          name: dto.name.trim(),
          mobile: cleanMobile,
          email: cleanEmail,
          passwordHash,
          role: Role.CENTRE, // FORCED strictly to CENTRE role
          status: userInitialStatus,
          partnerId,
          distributorId,
          registrationDate,
          expiryDate,
          mustChangePassword: true, // First-login password change required
        } as any,
      });

      const centre = await tx.centre.create({
        data: {
          userId: user.id,
          distributorId,
          centreName: dto.centreName.trim(),
          centreCode,
          address: dto.address?.trim() || `${dto.taluk}, ${dto.district}`,
          district: dto.district.trim(),
          taluk: dto.taluk.trim(),
          pincode: dto.pincode?.trim() || null,
          feePaid: true,
          registrationFee: new Prisma.Decimal(centreFeeAmount),
          feeTransactionId: payerUserId ? `CTR-FEE-${centreCode}` : null,
          status: initialStatus,
        },
      });

      const wallet = await tx.wallet.create({
        data: {
          userId: user.id,
          availableBalance: new Prisma.Decimal(0),
          reservedBalance: new Prisma.Decimal(0),
        },
      });

      if (dto.latitude !== undefined && dto.longitude !== undefined) {
        const coordValidation = isValidCoordinate({
          latitude: dto.latitude,
          longitude: dto.longitude,
          accuracy: dto.accuracy || 10,
        });

        if (!coordValidation.valid) {
          throw new BadRequestException(`Location validation failed: ${coordValidation.reason}`);
        }

        await tx.registeredLocation.create({
          data: {
            userId: user.id,
            latitude: dto.latitude,
            longitude: dto.longitude,
            accuracy: dto.accuracy || 10,
            address: dto.address || undefined,
            district: dto.district,
            status: 'ACTIVE',
          },
        });
      }

      return { user, centre, wallet, payerWalletUpdated };
    });

    if (result.payerWalletUpdated && this.eventsGateway && payerUserId) {
      try {
        this.eventsGateway.notifyWalletUpdated(payerUserId, {
          availableBalance: Number(result.payerWalletUpdated.availableBalance),
          reservedBalance: Number(result.payerWalletUpdated.reservedBalance),
        });
      } catch (_) {}
    }

    // 6. Broadcast Real-time WebSocket activation
    if (this.eventsGateway) {
      this.eventsGateway.notifyCentreActivated(partnerId || undefined, {
        centreCode: result.centre.centreCode || '',
        centreName: result.centre.centreName,
        district: result.centre.district,
        taluk: result.centre.taluk,
        timestamp: new Date().toISOString(),
      });
      this.eventsGateway.emitToAdmins('centre:activated', {
        centreCode: result.centre.centreCode || '',
        centreName: result.centre.centreName,
        district: result.centre.district,
        partnerId,
        distributorId,
      });
    }

    // 7. Record Audit Event (Never log passwords!)
    await this.audit.log({
      actorId: actorUser.id,
      actorType: actorUser.role === Role.SUPER_ADMIN ? 'ADMIN' : 'USER',
      action: 'CENTRE_CREATED',
      entity: 'Centre',
      entityId: result.centre.id,
      metadata: {
        centreCode: result.centre.centreCode,
        centreName: result.centre.centreName,
        district: result.centre.district,
        email: cleanEmail,
        createdBy: actorUser.email,
        actorRole: actorUser.role,
        partnerId,
        distributorId,
      },
    });

    return {
      message: 'Centre created and activated successfully',
      centre: result.centre,
      user: this.sanitizeUser(result.user),
      wallet: result.wallet,
      temporaryPassword, // Provided strictly on initial creation response for handoff
    };
  }

  async updateCentre(adminUser: any, id: string, dto: UpdateCentreDto) {
    const existing = await this.prisma.centre.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!existing) {
      throw new NotFoundException(`Centre with ID '${id}' not found`);
    }

    if (dto.centreCode && dto.centreCode !== existing.centreCode) {
      const codeTaken = await this.prisma.centre.findUnique({
        where: { centreCode: dto.centreCode },
      });
      if (codeTaken) {
        throw new ConflictException(`Centre Code '${dto.centreCode}' is already in use.`);
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const userUpdate: any = {};
      if (dto.name) userUpdate.name = dto.name.trim();
      if (dto.email) userUpdate.email = dto.email.toLowerCase().trim();
      if (dto.mobile) userUpdate.mobile = dto.mobile.trim();
      if (dto.expiryDate) userUpdate.expiryDate = new Date(dto.expiryDate);
      if (dto.status) {
        userUpdate.status =
          dto.status === CentreStatus.SUSPENDED ? UserStatus.SUSPENDED : UserStatus.ACTIVE;
      }

      if (Object.keys(userUpdate).length > 0) {
        await tx.user.update({
          where: { id: existing.userId },
          data: userUpdate,
        });
      }

      const centreUpdate: any = {};
      if (dto.centreName) centreUpdate.centreName = dto.centreName.trim();
      if (dto.centreCode) centreUpdate.centreCode = dto.centreCode.trim();
      if (dto.district) centreUpdate.district = dto.district.trim();
      if (dto.taluk) centreUpdate.taluk = dto.taluk.trim();
      if (dto.address !== undefined) centreUpdate.address = dto.address.trim();
      if (dto.pincode !== undefined) centreUpdate.pincode = dto.pincode?.trim() || null;
      if (dto.status) centreUpdate.status = dto.status;

      if (dto.latitude !== undefined && dto.longitude !== undefined) {
        const coordValidation = isValidCoordinate({
          latitude: dto.latitude,
          longitude: dto.longitude,
          accuracy: dto.accuracy || 10,
        });

        if (!coordValidation.valid) {
          throw new BadRequestException(`Location validation failed: ${coordValidation.reason}`);
        }

        await tx.registeredLocation.upsert({
          where: { userId: existing.userId },
          create: {
            userId: existing.userId,
            latitude: dto.latitude,
            longitude: dto.longitude,
            accuracy: dto.accuracy || 10,
            address: dto.address || existing.address,
            district: dto.district || existing.district,
            status: 'ACTIVE',
          },
          update: {
            latitude: dto.latitude,
            longitude: dto.longitude,
            accuracy: dto.accuracy || 10,
            address: dto.address || undefined,
            district: dto.district || undefined,
            updatedAt: new Date(),
          },
        });
      }

      return tx.centre.update({
        where: { id },
        data: centreUpdate,
        include: {
          user: {
            include: {
              registeredLocation: true,
              wallet: true,
            },
          },
        },
      });
    });

    await this.audit.log({
      actorId: adminUser.id,
      actorType: 'ADMIN',
      action: 'CENTRE_UPDATED',
      entity: 'Centre',
      entityId: id,
      metadata: { updatedFields: Object.keys(dto), updatedBy: adminUser.email },
    });

    return {
      message: 'Centre updated successfully',
      centre: {
        ...updated,
        user: this.sanitizeUser(updated.user),
      },
    };
  }

  async activateCentre(adminUser: any, id: string) {
    const centre = await this.prisma.centre.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!centre) {
      throw new NotFoundException(`Centre '${id}' not found`);
    }

    const now = new Date();
    const expiry =
      centre.user.expiryDate && centre.user.expiryDate > now
        ? centre.user.expiryDate
        : new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: centre.userId },
        data: {
          status: UserStatus.ACTIVE,
          expiryDate: expiry,
        },
      });

      return tx.centre.update({
        where: { id },
        data: { status: CentreStatus.ACTIVE },
        include: {
          user: true,
        },
      });
    });

    await this.audit.log({
      actorId: adminUser.id,
      actorType: 'ADMIN',
      action: 'CENTRE_ACTIVATED',
      entity: 'Centre',
      entityId: id,
      metadata: { activatedBy: adminUser.email, newExpiryDate: expiry },
    });

    return {
      message: 'Centre activated successfully',
      centre: {
        ...updated,
        user: this.sanitizeUser(updated.user),
      },
    };
  }

  async suspendCentre(adminUser: any, id: string) {
    const centre = await this.prisma.centre.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!centre) {
      throw new NotFoundException(`Centre '${id}' not found`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: centre.userId },
        data: { status: UserStatus.SUSPENDED },
      });

      return tx.centre.update({
        where: { id },
        data: { status: CentreStatus.SUSPENDED },
        include: {
          user: true,
        },
      });
    });

    await this.audit.log({
      actorId: adminUser.id,
      actorType: 'ADMIN',
      action: 'CENTRE_SUSPENDED',
      entity: 'Centre',
      entityId: id,
      metadata: { suspendedBy: adminUser.email },
    });

    return {
      message: 'Centre suspended successfully',
      centre: {
        ...updated,
        user: this.sanitizeUser(updated.user),
      },
    };
  }

  async reissueActivation(actorUser: any, id: string) {
    const centre = await this.prisma.centre.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!centre) {
      throw new NotFoundException(`Centre '${id}' not found`);
    }

    if (actorUser.role === Role.DISTRIBUTOR) {
      const dist = await this.prisma.distributor.findFirst({
        where: {
          OR: [
            { userId: actorUser.id },
            { id: actorUser.distributorId || '' },
          ],
        },
      });
      if (!dist || centre.distributorId !== dist.id) {
        throw new ForbiddenException('You do not have permission to manage this centre.');
      }
    } else if (actorUser.role === Role.PARTNER) {
      const partner = await this.prisma.partner.findFirst({
        where: {
          OR: [
            { userId: actorUser.id },
            { id: actorUser.partnerId || '' },
          ],
        },
      });
      if (!partner || centre.user?.partnerId !== partner.id) {
        throw new ForbiddenException('You do not have permission to manage this centre.');
      }
    }

    const temporaryPassword = this.generateTemporaryPassword();
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(temporaryPassword, saltRounds);

    await this.prisma.user.update({
      where: { id: centre.userId },
      data: {
        passwordHash,
        mustChangePassword: true,
        status:
          centre.user.status === UserStatus.SUSPENDED
            ? UserStatus.SUSPENDED
            : UserStatus.ACTIVE,
      } as any,
    });

    await this.audit.log({
      actorId: actorUser.id,
      actorType: actorUser.role === Role.SUPER_ADMIN ? 'ADMIN' : actorUser.role,
      action: 'CENTRE_ACTIVATION_REISSUED',
      entity: 'Centre',
      entityId: id,
      metadata: { reissuedBy: actorUser.email, actorRole: actorUser.role },
    });

    return {
      message: 'Activation credentials reissued. Operator must change password on next sign-in.',
      centreId: id,
      centreCode: centre.centreCode,
      centreName: centre.centreName,
      ownerName: centre.user?.name,
      mobile: centre.user?.mobile,
      operatorEmail: centre.user?.email,
      temporaryPassword,
    };
  }

  async adjustCentreWallet(
    adminUser: any,
    centreId: string,
    dto: { amount: number; action: 'CREDIT' | 'DEBIT'; reason?: string },
  ) {
    const amount = Number(dto.amount);
    if (!amount || isNaN(amount) || amount <= 0) {
      throw new BadRequestException('Adjustment amount must be a positive number greater than 0.');
    }

    if (dto.action !== 'CREDIT' && dto.action !== 'DEBIT') {
      throw new BadRequestException("Action must be either 'CREDIT' or 'DEBIT'.");
    }

    const centre = await this.prisma.centre.findUnique({
      where: { id: centreId },
      include: {
        user: {
          include: {
            wallet: true,
          },
        },
      },
    });

    if (!centre) {
      throw new NotFoundException(`Centre with ID '${centreId}' not found`);
    }

    return await this.prisma.$transaction(async (tx) => {
      // 1. Get or create wallet for the centre user
      let wallet = centre.user?.wallet;
      if (!wallet) {
        wallet = await tx.wallet.create({
          data: {
            userId: centre.userId,
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
            `Cannot deduct ₹${amount}: Insufficient available balance (Current balance: ₹${prevAvailable.toFixed(2)}).`,
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
          userId: centre.userId,
          type: TransactionType.ADJUSTMENT,
          amount: new Prisma.Decimal(dto.action === 'CREDIT' ? amount : -amount),
          status: TransactionStatus.COMPLETED,
          reference: `ADMIN-${dto.action}-${Date.now()}`,
          metadata: {
            adminId: adminUser.id,
            adminEmail: adminUser.email,
            action: dto.action,
            amount,
            reason: dto.reason?.trim() || `Manual Admin ${dto.action === 'CREDIT' ? 'Credit' : 'Deduction'}`,
            previousBalance: prevAvailable,
            newBalance: newAvailable,
            centreCode: centre.centreCode,
            centreName: centre.centreName,
          },
        },
      });

      // 4. Audit log
      await this.audit.log({
        actorId: adminUser.id,
        actorType: 'ADMIN',
        action: dto.action === 'CREDIT' ? 'CENTRE_WALLET_CREDIT' : 'CENTRE_WALLET_DEBIT',
        entity: 'Wallet',
        entityId: wallet.id,
        metadata: {
          centreId: centre.id,
          centreCode: centre.centreCode,
          centreName: centre.centreName,
          action: dto.action,
          amount,
          previousBalance: prevAvailable,
          newBalance: newAvailable,
          reason: dto.reason || null,
        },
      });

      return {
        success: true,
        message: `Successfully ${dto.action === 'CREDIT' ? 'credited' : 'deducted'} ₹${amount.toFixed(2)} ${dto.action === 'CREDIT' ? 'to' : 'from'} ${centre.centreName}'s wallet.`,
        wallet: updatedWallet,
        transaction,
      };
    });
  }

  async deleteCentre(adminUser: any, id: string) {
    const centre = await this.prisma.centre.findFirst({
      where: {
        OR: [{ id }, { userId: id }, { centreCode: id }],
      },
      include: {
        user: true,
      },
    });

    if (!centre) {
      throw new NotFoundException('Centre profile not found');
    }

    // Guard against deleting centre with in-flight active booking requests
    const activeBookingCount = await this.prisma.bookingRequest.count({
      where: {
        userId: centre.userId,
        status: {
          notIn: ['SUCCESS', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT'] as any,
        },
      },
    });

    if (activeBookingCount > 0) {
      throw new BadRequestException(
        `Cannot delete centre '${centre.centreName}' (${centre.centreCode}) because it has ${activeBookingCount} active or in-flight booking request(s). Please cancel or complete them first.`,
      );
    }

    // Delete centre and its associated user (User deletion cascades to Centre, Wallet, Location, etc.)
    await this.prisma.$transaction(async (tx) => {
      await tx.user.delete({
        where: { id: centre.userId },
      });
    });

    // Write audit log
    await this.audit.log({
      actorId: adminUser?.id || null,
      actorType: 'ADMIN',
      action: 'CENTRE_DELETED',
      entity: 'Centre',
      entityId: centre.id,
      metadata: {
        centreId: centre.id,
        centreCode: centre.centreCode,
        centreName: centre.centreName,
        district: centre.district,
        userEmail: centre.user?.email,
        userMobile: centre.user?.mobile,
        deletedByUserId: adminUser?.id,
        deletedByEmail: adminUser?.email,
      },
    });

    // Emit event for real-time dashboards
    try {
      this.eventsGateway?.server?.emit('centre:deleted', {
        id: centre.id,
        centreCode: centre.centreCode,
      });
    } catch (_) {}

    return {
      success: true,
      message: `Centre '${centre.centreName}' (${centre.centreCode}) has been permanently deleted.`,
    };
  }

  async getNetworkStats() {
    const [registeredCount, activeCount, suspendedCount, districtGrouping] = await Promise.all([
      this.prisma.centre.count(),
      this.prisma.centre.count({ where: { status: 'ACTIVE' } }),
      this.prisma.centre.count({ where: { status: 'SUSPENDED' } }),
      this.prisma.centre.groupBy({
        by: ['district'],
        _count: { id: true },
      }),
    ]);

    const activeDistricts = districtGrouping.filter((d) => d.district).length;

    return {
      registeredCount,
      activeCount,
      suspendedCount,
      districtCount: activeDistricts,
      districtsCoveredText: `${activeDistricts} / 38`,
      districtGrouping: districtGrouping.map((d) => ({
        district: d.district,
        count: d._count.id,
      })),
    };
  }

  private async generateUniqueCentreCode(district: string): Promise<string> {
    const distCode = district.substring(0, 3).toUpperCase();
    const count = await this.prisma.centre.count({
      where: { district: { equals: district, mode: 'insensitive' } },
    });

    for (let offset = 1; offset <= 1000; offset++) {
      const candidate = `TN-${distCode}-${(count + offset).toString().padStart(3, '0')}`;
      const exists = await this.prisma.centre.findUnique({
        where: { centreCode: candidate },
      });
      if (!exists) {
        return candidate;
      }
    }

    return `TN-CTR-${Date.now().toString().slice(-6)}`;
  }

  private generateTemporaryPassword(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'TA@';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  private sanitizeUser(user: any) {
    if (!user) return null;
    const { passwordHash, ...sanitized } = user;
    return sanitized;
  }
}
