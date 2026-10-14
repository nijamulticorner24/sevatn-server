import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  LoginDto,
  ChangePasswordDto,
  RegisterByInvitationDto,
  VerifyRegistrationPaymentDto,
  UpdateLocationDto,
} from './dto/auth.dto';
import { UserStatus, CentreStatus, Role, InvitationStatus, Prisma } from '@prisma/client';
import { isValidCoordinate } from '../common/utils/geo';

import { EventsGateway } from '../events/events.gateway';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private audit: AuditService,
    private eventsGateway: EventsGateway,
  ) {}

  /**
   * Public self-registration is strictly disabled by policy.
   */
  async registerCentre() {
    throw new ForbiddenException(
      'Public self-registration is disabled. Users must register using an authorized SevaTN Partner invitation link.',
    );
  }

  /**
   * Validates invitation token before showing registration form
   */
  async validateInvitation(token: string) {
    if (!token || token.trim().length < 8) {
      throw new BadRequestException('Invalid invitation token format');
    }

    const invitation = await this.prisma.partnerInvitation.findUnique({
      where: { token: token.trim() },
      include: {
        partner: true,
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

    if (invitation.partner.status !== 'ACTIVE') {
      throw new BadRequestException(`Authorized partner (${invitation.partner.name}) is currently ${invitation.partner.status}`);
    }

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

  /**
   * User registers ONLY via valid Partner invitation link
   * Server determines the partner association from token (no client partnerId spoofing).
   */
  async registerByInvitation(dto: RegisterByInvitationDto) {
    const cleanEmail = dto.email.toLowerCase().trim();
    const cleanMobile = dto.mobile.trim();

    // 1. Validate Token & identify partner server-side
    const invitationValidation = await this.validateInvitation(dto.invitationToken);
    const partnerId = invitationValidation.partner.id;

    // 2. Validate coordinates sanity
    const coordValidation = isValidCoordinate({
      latitude: dto.latitude,
      longitude: dto.longitude,
      accuracy: dto.accuracy,
    });
    if (!coordValidation.valid) {
      throw new BadRequestException(`Location validation failed: ${coordValidation.reason}`);
    }

    // 3. Duplicate checks
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: cleanEmail }, { mobile: cleanMobile }],
      },
    });

    if (existing) {
      throw new ConflictException(
        `An account with email (${cleanEmail}) or mobile (${cleanMobile}) already exists.`,
      );
    }

    // 4. Generate guaranteed unique centre code & hash password
    const centreCode = await this.generateUniqueCentreCode(dto.district);
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(dto.password, saltRounds);

    const result = await this.prisma.$transaction(async (tx) => {
      // Create User in PAYMENT_PENDING state
      const user = await tx.user.create({
        data: {
          name: dto.name.trim(),
          email: cleanEmail,
          mobile: cleanMobile,
          passwordHash,
          role: Role.CENTRE,
          status: UserStatus.PAYMENT_PENDING,
          partnerId,
          mustChangePassword: false,
        } as any,
      });

      // Create Centre profile
      const centre = await tx.centre.create({
        data: {
          userId: user.id,
          centreName: dto.centreName.trim(),
          centreCode,
          address: dto.address?.trim() || `${dto.taluk}, ${dto.district}`,
          district: dto.district.trim(),
          taluk: dto.taluk.trim(),
          pincode: dto.pincode?.trim() || null,
          registrationFee: new Prisma.Decimal(249.0),
          feePaid: false,
          status: CentreStatus.PENDING_VERIFICATION,
        },
      });

      // Create RegisteredLocation (Base for 5 KM Access Control)
      const location = await tx.registeredLocation.create({
        data: {
          userId: user.id,
          latitude: dto.latitude,
          longitude: dto.longitude,
          accuracy: dto.accuracy || null,
          address: dto.address?.trim() || `${dto.taluk}, ${dto.district}`,
          district: dto.district.trim(),
          status: 'ACTIVE',
        },
      });

      // Initialize Wallet (Balance: ₹0)
      const wallet = await tx.wallet.create({
        data: {
          userId: user.id,
          availableBalance: new Prisma.Decimal(0),
          reservedBalance: new Prisma.Decimal(0),
        },
      });

      // Mark PartnerInvitation as USED
      await tx.partnerInvitation.update({
        where: { token: dto.invitationToken.trim() },
        data: {
          status: InvitationStatus.USED,
          usedAt: new Date(),
          usedByUserId: user.id,
        },
      });

      return { user, centre, location, wallet };
    });

    await this.audit.log({
      actorId: result.user.id,
      actorType: 'USER',
      action: 'USER_REGISTERED',
      entity: 'User',
      entityId: result.user.id,
      metadata: {
        partnerId,
        partnerCode: invitationValidation.partner.partnerCode,
        centreCode: result.centre.centreCode,
        email: cleanEmail,
      },
    });

    await this.audit.log({
      actorId: result.user.id,
      actorType: 'USER',
      action: 'LOCATION_REGISTERED',
      entity: 'RegisteredLocation',
      entityId: result.location.id,
      metadata: {
        latitude: dto.latitude,
        longitude: dto.longitude,
        district: dto.district,
      },
    });

    // Broadcast WebSocket Live Event to Partner & Admin
    this.eventsGateway.notifyCentreActivated(partnerId, {
      centreCode: result.centre.centreCode || '',
      centreName: result.centre.centreName,
      district: result.centre.district,
      taluk: result.centre.taluk,
      timestamp: new Date().toISOString(),
    });

    return {
      message: 'Registration submitted successfully. Please complete the ₹249 centre onboarding fee.',
      userId: result.user.id,
      email: result.user.email,
      centreCode: result.centre.centreCode,
      status: result.user.status,
      registrationFee: 249,
      partner: invitationValidation.partner,
    };
  }

  /**
   * Verifies registration payment server-side with idempotency and activates account
   */
  async verifyRegistrationPayment(dto: VerifyRegistrationPaymentDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      include: { centre: true, wallet: true },
    });

    if (!user) {
      throw new NotFoundException('User account not found');
    }

    if (user.status === UserStatus.ACTIVE && user.centre?.feePaid) {
      return {
        message: 'Account is already active (idempotent)',
        user: this.sanitizeUser(user),
        centre: user.centre,
      };
    }

    const registrationFee = Number(user.centre?.registrationFee || 249);
    const now = new Date();
    const expiryDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 1-year active license
    const isOnline = dto.paymentMethod === 'ONLINE' || (!dto.paymentMethod && !dto.screenshotUrl);
    const paymentRef = dto.paymentReference?.trim() || (dto.screenshotUrl ? 'RECEIPT_PROOF_ATTACHED' : `PAY-${Date.now()}`);

    if (isOnline) {
      // 1. ONLINE GATEWAY: Instant auto-verification & activation
      const result = await this.prisma.$transaction(async (tx) => {
        const updatedUser = await tx.user.update({
          where: { id: user.id },
          data: {
            status: UserStatus.ACTIVE,
            registrationDate: now,
            expiryDate,
          },
        });

        const updatedCentre = await (tx as any).centre.update({
          where: { userId: user.id },
          data: {
            status: CentreStatus.ACTIVE,
            feePaid: true,
            feeTransactionId: paymentRef,
          },
        });

        return { updatedUser, updatedCentre };
      });

      await this.audit.log({
        actorId: user.id,
        actorType: 'USER',
        action: 'USER_PAYMENT_VERIFIED',
        entity: 'Centre',
        entityId: result.updatedCentre.id,
        metadata: {
          paymentReference: paymentRef,
          paymentMethod: 'ONLINE_AUTO_VERIFIED',
          amount: registrationFee,
          expiryDate,
        },
      });

      // Broadcast WebSocket Live Event to Partner & Admin
      this.eventsGateway.notifyCentreActivated(user.partnerId || undefined, {
        centreCode: result.updatedCentre.centreCode || '',
        centreName: result.updatedCentre.centreName,
        district: result.updatedCentre.district,
        taluk: result.updatedCentre.taluk,
        timestamp: new Date().toISOString(),
      });

      const token = this.generateToken(result.updatedUser);

      return {
        message: 'Payment verified successfully! Account is now ACTIVE.',
        user: this.sanitizeUser(result.updatedUser),
        centre: result.updatedCentre,
        token,
        isAutoActivated: true,
      };
    } else {
      // 2. OFFLINE PAYMENT (QR / UPI): Proof submitted -> Awaiting Admin / Partner Verification
      const updatedCentre = await (this.prisma as any).centre.update({
        where: { userId: user.id },
        data: {
          status: CentreStatus.PENDING_VERIFICATION,
          feePaid: false,
          feeTransactionId: paymentRef,
          paymentProofUrl: dto.screenshotUrl?.trim() || null,
        },
      });

      await this.audit.log({
        actorId: user.id,
        actorType: 'USER',
        action: 'CENTRE_OFFLINE_PAYMENT_SUBMITTED',
        entity: 'Centre',
        entityId: updatedCentre.id,
        metadata: {
          paymentReference: paymentRef,
          hasScreenshot: !!dto.screenshotUrl,
          amount: registrationFee,
          status: 'PENDING_ADMIN_VERIFICATION',
        },
      });

      if (this.eventsGateway) {
        this.eventsGateway.emitToAdmins('admin:centre_payment_submitted', {
          centreId: updatedCentre.id,
          centreCode: updatedCentre.centreCode,
          centreName: updatedCentre.centreName,
          district: updatedCentre.district,
          paymentReference: paymentRef,
          hasScreenshot: !!dto.screenshotUrl,
          timestamp: new Date().toISOString(),
        });
      }

      return {
        message: 'Offline registration fee reference and receipt proof submitted successfully. Platform Admin will verify and activate your centre account.',
        centre: updatedCentre,
        isAutoActivated: false,
      };
    }
  }

  /**
   * Register or update user's service location
   */
  async updateLocation(userId: string, dto: UpdateLocationDto) {
    const coordValidation = isValidCoordinate({
      latitude: dto.latitude,
      longitude: dto.longitude,
      accuracy: dto.accuracy,
    });

    if (!coordValidation.valid) {
      throw new BadRequestException(`Location validation failed: ${coordValidation.reason}`);
    }

    const location = await this.prisma.registeredLocation.upsert({
      where: { userId },
      create: {
        userId,
        latitude: dto.latitude,
        longitude: dto.longitude,
        accuracy: dto.accuracy || null,
        address: dto.address || null,
        district: dto.district || null,
        status: 'ACTIVE',
      },
      update: {
        latitude: dto.latitude,
        longitude: dto.longitude,
        accuracy: dto.accuracy || null,
        address: dto.address || undefined,
        district: dto.district || undefined,
        capturedAt: new Date(),
      },
    });

    await this.audit.log({
      actorId: userId,
      actorType: 'USER',
      action: 'LOCATION_REGISTERED',
      entity: 'RegisteredLocation',
      entityId: location.id,
      metadata: { latitude: dto.latitude, longitude: dto.longitude },
    });

    return {
      message: 'Service location registered successfully',
      location,
    };
  }

  /**
   * Get authenticated user profile with partner, location & wallet details
   */
  async getMyProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        centre: true,
        wallet: true,
        partner: true,
        partnerProfile: true,
        registeredLocation: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User profile not found');
    }

    return {
      user: this.sanitizeUser(user),
      centre: user.centre,
      wallet: user.wallet,
      partner: (user as any).partnerProfile || user.partner,
      registeredLocation: user.registeredLocation,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: dto.identifier }, { mobile: dto.identifier }],
      },
      include: {
        centre: true,
        wallet: true,
        partner: true,
        partnerProfile: true,
        registeredLocation: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid mobile/email or password');
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('This account has been suspended. Please contact platform administrators.');
    }

    if ((user.role as string) === 'ADMIN') {
      throw new ForbiddenException('The ADMIN role has been retired. Please use an authorized Super Admin account.');
    }

    const isMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid mobile/email or password');
    }

    // Check Partner status & payment verification
    if (user.role === Role.PARTNER) {
      let partner = (user as any).partnerProfile || user.partner;
      if (!partner && user.partnerId) {
        partner = await (this.prisma as any).partner.findUnique({
          where: { id: user.partnerId },
        });
      }
      if (!partner) {
        partner = await (this.prisma as any).partner.findFirst({
          where: {
            OR: [{ email: user.email }, { mobile: user.mobile }, { userId: user.id }],
          },
        });
      }

      if (partner) {
        if (partner.status === 'PENDING_PAYMENT') {
          throw new ForbiddenException(
            'Your partner franchise account is awaiting fee payment. Please complete your franchise payment using your onboarding link before logging in.',
          );
        }
        if (partner.status === 'PENDING_APPROVAL') {
          throw new ForbiddenException(
            'Your partner franchise payment is currently under review by the platform administrator. Login will be enabled once your payment is verified and approved.',
          );
        }
        if (partner.status === 'SUSPENDED' || partner.status === 'DISABLED') {
          throw new ForbiddenException(
            'Your partner franchise account has been suspended or disabled. Please contact platform administrators.',
          );
        }
        if (partner.status !== 'ACTIVE') {
          throw new ForbiddenException(
            `Your partner franchise account is currently ${partner.status}. Login will be enabled once activated by an administrator.`,
          );
        }
      } else if (user.status === UserStatus.PAYMENT_PENDING) {
        throw new ForbiddenException(
          'Your partner franchise account is awaiting fee payment verification.',
        );
      }
    }

    // Check Centre status & payment verification
    if (user.role === Role.CENTRE) {
      if (user.status === UserStatus.PAYMENT_PENDING || (user.centre && !user.centre.feePaid)) {
        if (user.centre?.paymentProofUrl || user.centre?.feeTransactionId) {
          throw new ForbiddenException(
            'Your centre registration payment proof has been submitted and is currently under verification by the platform administrator. Login will be enabled once approved.',
          );
        }
        throw new ForbiddenException(
          'Your centre onboarding registration fee payment is pending. Please complete your registration payment to activate and access your account.',
        );
      }
      if (user.centre && user.centre.status === CentreStatus.PENDING_VERIFICATION && !user.centre.feePaid) {
        throw new ForbiddenException(
          'Your centre registration is currently under review and payment verification by the platform administrator.',
        );
      }
      if (user.centre && user.centre.status === CentreStatus.SUSPENDED) {
        throw new ForbiddenException(
          'Your centre account has been suspended. Please contact platform support.',
        );
      }
      if (user.centre && user.centre.status === CentreStatus.EXPIRED) {
        throw new ForbiddenException(
          'Your centre license has expired. Please renew your annual subscription to continue.',
        );
      }
    }

    // Check general user statuses
    if (user.status === UserStatus.PAYMENT_PENDING) {
      throw new ForbiddenException(
        'Your account is pending payment verification. Login is blocked until payment is completed and approved.',
      );
    }
    if (user.status === UserStatus.REGISTERED) {
      throw new ForbiddenException(
        'Your account registration is incomplete. Please complete the registration payment.',
      );
    }

    // Check 45-day validity check
    if (user.expiryDate && new Date() > user.expiryDate && user.status === UserStatus.ACTIVE) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { status: UserStatus.EXPIRED },
      });
      user.status = UserStatus.EXPIRED;
      throw new ForbiddenException(
        'Your account validity has expired. Please renew your subscription.',
      );
    }

    const token = this.generateToken(user);

    await this.audit.log({
      actorId: user.id,
      actorType: 'USER',
      action: 'USER_LOGIN',
      entity: 'User',
      entityId: user.id,
    });

    return {
      message: 'Login successful',
      user: this.sanitizeUser(user),
      centre: user.centre,
      wallet: user.wallet,
      partner: (user as any).partnerProfile || user.partner,
      registeredLocation: user.registeredLocation,
      token,
      mustChangePassword: !!(user as any).mustChangePassword,
    };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User account not found');
    }

    if (!dto.newPassword || dto.newPassword.length < 8) {
      throw new BadRequestException('New password must be at least 8 characters long');
    }

    const isFirstLoginReset = !!(user as any).mustChangePassword;
    if (!isFirstLoginReset && dto.currentPassword) {
      const isMatch = await bcrypt.compare(dto.currentPassword, user.passwordHash);
      if (!isMatch) {
        throw new BadRequestException('Current password does not match');
      }
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(dto.newPassword, saltRounds);

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        mustChangePassword: false,
      } as any,
    });

    await this.audit.log({
      actorId: userId,
      actorType: 'USER',
      action: 'PASSWORD_CHANGED',
      entity: 'User',
      entityId: userId,
      metadata: { firstLoginReset: isFirstLoginReset },
    });

    return {
      message: 'Password changed successfully',
      mustChangePassword: false,
      user: this.sanitizeUser(updatedUser),
    };
  }

  private generateToken(user: any) {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      mustChangePassword: !!user.mustChangePassword,
    };
    return this.jwtService.sign(payload);
  }

  private async generateUniqueCentreCode(district: string): Promise<string> {
    const rawDist = (district || 'CEN').replace(/[^a-zA-Z]/g, '').trim();
    const distCode = (rawDist.substring(0, 3) || 'CEN').toUpperCase();
    const prefix = `TN-${distCode}-`;

    const existingCentres = await this.prisma.centre.findMany({
      where: {
        centreCode: {
          startsWith: prefix,
          mode: 'insensitive',
        },
      },
      select: { centreCode: true },
    });

    let nextNum = existingCentres.length + 1;
    let candidate = `${prefix}${nextNum.toString().padStart(3, '0')}`;

    const existingSet = new Set(existingCentres.map((c) => c.centreCode?.toUpperCase()));
    while (existingSet.has(candidate.toUpperCase())) {
      nextNum++;
      candidate = `${prefix}${nextNum.toString().padStart(3, '0')}`;
    }

    return candidate;
  }

  private sanitizeUser(user: any) {
    if (!user) return null;
    const { passwordHash, ...sanitized } = user;
    return sanitized;
  }
}
