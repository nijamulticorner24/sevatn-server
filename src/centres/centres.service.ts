import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateCentreDto, UpdateCentreDto } from './dto/centre.dto';
import { Role, UserStatus, CentreStatus, Prisma } from '@prisma/client';
import { isValidCoordinate } from '../common/utils/geo';
import * as bcrypt from 'bcrypt';

@Injectable()
export class CentresService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async getMyCentre(userId: string) {
    const centre = await this.prisma.centre.findUnique({
      where: { userId },
      include: {
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

  async createCentre(adminUser: any, dto: CreateCentreDto) {
    const cleanEmail = dto.email.toLowerCase().trim();
    const cleanMobile = dto.mobile.trim();

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

    // 5. Execute Transactional Creation
    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: dto.name.trim(),
          mobile: cleanMobile,
          email: cleanEmail,
          passwordHash,
          role: Role.CENTRE, // FORCED strictly to CENTRE role
          status: userInitialStatus,
          registrationDate,
          expiryDate,
          mustChangePassword: true, // First-login password change required
        } as any,
      });

      const centre = await tx.centre.create({
        data: {
          userId: user.id,
          centreName: dto.centreName.trim(),
          centreCode,
          address: dto.address?.trim() || `${dto.taluk}, ${dto.district}`,
          district: dto.district.trim(),
          taluk: dto.taluk.trim(),
          pincode: dto.pincode?.trim() || null,
          feePaid: true,
          registrationFee: new Prisma.Decimal(249),
          feeTransactionId: `ADMIN-ONBOARDING-${Date.now()}`,
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

      return { user, centre, wallet };
    });

    // 6. Record Audit Event (Never log passwords!)
    await this.audit.log({
      actorId: adminUser.id,
      actorType: 'ADMIN',
      action: 'CENTRE_CREATED',
      entity: 'Centre',
      entityId: result.centre.id,
      metadata: {
        centreCode: result.centre.centreCode,
        centreName: result.centre.centreName,
        district: result.centre.district,
        email: cleanEmail,
        createdBy: adminUser.email,
      },
    });

    return {
      message: 'Centre created and activated successfully by administrator',
      centre: result.centre,
      user: this.sanitizeUser(result.user),
      wallet: result.wallet,
      temporaryPassword, // Provided strictly on initial creation response for admin handoff
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

  async reissueActivation(adminUser: any, id: string) {
    const centre = await this.prisma.centre.findUnique({
      where: { id },
      include: { user: true },
    });

    if (!centre) {
      throw new NotFoundException(`Centre '${id}' not found`);
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
      actorId: adminUser.id,
      actorType: 'ADMIN',
      action: 'CENTRE_ACTIVATION_REISSUED',
      entity: 'Centre',
      entityId: id,
      metadata: { reissuedBy: adminUser.email },
    });

    return {
      message: 'Activation credentials reissued. Operator must change password on next sign-in.',
      centreId: id,
      centreCode: centre.centreCode,
      operatorEmail: centre.user.email,
      temporaryPassword,
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
