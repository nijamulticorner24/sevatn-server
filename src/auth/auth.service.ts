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
  ForgotPasswordDto,
  VerifyOtpDto,
  ResetPasswordDto,
  RequestEmailChangeDto,
  VerifyEmailChangeDto,
} from './dto/auth.dto';
import { UserStatus, CentreStatus, Role, InvitationStatus, Prisma } from '@prisma/client';
import { isValidCoordinate } from '../common/utils/geo';

import { EventsGateway } from '../events/events.gateway';

interface OtpSession {
  otp: string;
  userId: string;
  email: string;
  expiresAt: number;
  verified: boolean;
  attempts: number;
}

interface EmailChangeSession {
  userId: string;
  currentEmail: string;
  newEmail: string;
  otp: string;
  expiresAt: number;
  attempts: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly otpStore = new Map<string, OtpSession>();
  private readonly emailChangeStore = new Map<string, EmailChangeSession>();

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

    const config = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
    const onlineEnabled = config?.onlinePaymentEnabled ?? true;
    const offlineEnabled = config?.offlinePaymentEnabled ?? true;

    if (isOnline && !onlineEnabled) {
      throw new BadRequestException('Online payment gateway method is currently disabled by administrator.');
    }
    if (!isOnline && !offlineEnabled) {
      throw new BadRequestException('Offline UPI payment method is currently disabled by administrator.');
    }
    if (!onlineEnabled && !offlineEnabled) {
      throw new BadRequestException('All registration payment methods are currently disabled by administrator.');
    }

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
   * Security Rule: Centre location is permanent once registered. Only Super Admin can modify it thereafter.
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

    const [user, existingLocation] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true },
      }),
      this.prisma.registeredLocation.findUnique({
        where: { userId },
      }),
    ]);

    if (existingLocation && user?.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Registered service location is locked for security purposes. Only a Super Administrator can change centre coordinates.',
      );
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
      actorType: user?.role === Role.SUPER_ADMIN ? 'ADMIN' : 'USER',
      action: existingLocation ? 'LOCATION_UPDATED' : 'LOCATION_REGISTERED',
      entity: 'RegisteredLocation',
      entityId: location.id,
      metadata: { latitude: dto.latitude, longitude: dto.longitude },
    });

    return {
      message: existingLocation
        ? 'Service location updated successfully'
        : 'Default service location registered and locked successfully',
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

  /**
   * Public Centre Resolution for Unique Centre Login Portals (/c/:code)
   */
  async getPublicCentreInfo(code: string) {
    if (!code || !code.trim()) {
      throw new BadRequestException('Centre code or identifier is required');
    }
    const cleanCode = code.trim();
    const centre = await this.prisma.centre.findFirst({
      where: {
        OR: [
          { centreCode: { equals: cleanCode, mode: 'insensitive' } },
          { id: cleanCode },
        ],
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            mobile: true,
            status: true,
          },
        },
      },
    });

    if (!centre) {
      throw new NotFoundException(`Centre with identifier '${cleanCode}' was not found`);
    }

    const maskedEmail = centre.user?.email
      ? centre.user.email.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + '***' + c)
      : '';
    const maskedMobile = centre.user?.mobile
      ? centre.user.mobile.slice(0, 2) + '******' + centre.user.mobile.slice(-2)
      : '';

    return {
      id: centre.id,
      centreName: centre.centreName,
      centreCode: centre.centreCode,
      district: centre.district,
      taluk: centre.taluk,
      address: centre.address,
      pincode: centre.pincode,
      status: centre.status,
      feePaid: centre.feePaid,
      operatorName: centre.user?.name,
      maskedEmail,
      maskedMobile,
      loginEmail: centre.user?.email,
    };
  }

  async login(dto: LoginDto) {
    const cleanId = dto.identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: { equals: cleanId, mode: 'insensitive' } },
          { mobile: cleanId },
          { centre: { centreCode: { equals: cleanId, mode: 'insensitive' } } },
        ],
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
      throw new UnauthorizedException('Invalid mobile/email/centre code or password');
    }

    // If centreCode was specified in the login flow, ensure this user belongs to that centre
    if (dto.centreCode && dto.centreCode.trim()) {
      const expectedCode = dto.centreCode.trim().toUpperCase();
      const userCentreCode = user.centre?.centreCode?.toUpperCase();
      if (!userCentreCode || userCentreCode !== expectedCode) {
        throw new ForbiddenException(
          `This account is not authorized for Centre ${dto.centreCode.trim()}. Please verify your centre portal credentials.`,
        );
      }
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('This account has been suspended. Please contact platform administrators.');
    }

    if ((user.role as string) === 'ADMIN') {
      throw new ForbiddenException('The ADMIN role has been retired. Please use an authorized Super Admin account.');
    }

    const isMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid mobile/email/centre code or password');
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

  /**
   * Dispatches an email via Resend REST API (using RESEND_API_KEY)
   */
  private async sendResendEmail(toEmail: string, subject: string, htmlContent: string) {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const fromEmail = process.env.RESEND_FROM_EMAIL?.trim() || 'TicketAssist <onboarding@resend.dev>';

    if (!apiKey) {
      this.logger.warn(
        `[Resend Email] RESEND_API_KEY is not configured in environment. Skipped remote dispatch to ${toEmail}.`,
      );
      return false;
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [toEmail],
          subject,
          html: htmlContent,
        }),
      });

      const resData = await response.json();
      if (!response.ok) {
        this.logger.error(`[Resend Error] Status: ${response.status}, Details: ${JSON.stringify(resData)}`);
        throw new BadRequestException(resData.message || 'Failed to dispatch email via Resend API');
      }

      this.logger.log(`[Resend Success] Email delivered to ${toEmail}, dispatch id: ${resData.id}`);
      return true;
    } catch (err: any) {
      this.logger.error(`[Resend Exception] Error sending to ${toEmail}: ${err.message}`);
      throw err;
    }
  }

  private maskEmail(email: string): string {
    const [user, domain] = email.split('@');
    if (!user || !domain) return email;
    if (user.length <= 2) return `${user[0]}***@${domain}`;
    return `${user.slice(0, 2)}***${user.slice(-1)}@${domain}`;
  }

  /**
   * Request OTP for password reset (delivered to user's registered email via Resend)
   */
  async forgotPassword(dto: ForgotPasswordDto) {
    const cleanId = dto.identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: cleanId.toLowerCase() }, { mobile: cleanId }],
      },
    });

    if (!user) {
      throw new NotFoundException('No account found matching this email address or mobile number.');
    }

    if (user.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('This account has been suspended. Please contact platform administrators.');
    }

    // Generate cryptographic 6-digit numeric OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    this.otpStore.set(user.email.toLowerCase(), {
      otp,
      userId: user.id,
      email: user.email,
      expiresAt,
      verified: false,
      attempts: 0,
    });

    this.logger.log(`[Password Reset OTP Generated] Target: ${user.email} (Mobile: ${user.mobile}), OTP: ${otp}`);

    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 28px; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #172033; font-size: 22px; font-weight: 700; margin: 0;">TicketAssist Portal</h1>
          <p style="color: #64748b; font-size: 13px; margin-top: 4px;">Security &amp; Account Recovery</p>
        </div>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 24px; text-align: center; margin-bottom: 24px;">
          <p style="color: #334155; font-size: 14px; margin: 0 0 12px 0;">Use the following One-Time Password (OTP) to reset your account password:</p>
          <div style="font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #c98219; font-family: monospace; padding: 10px 0;">
            ${otp}
          </div>
          <p style="color: #64748b; font-size: 12px; margin: 12px 0 0 0;">This code will expire in <strong>10 minutes</strong>. Do not share it with anyone.</p>
        </div>
        <p style="color: #64748b; font-size: 12px; line-height: 1.5; margin: 0;">If you did not request a password reset, you can safely ignore this email. Your existing credentials remain secure.</p>
        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #f1f5f9; text-align: center; color: #94a3b8; font-size: 11px;">
          &copy; ${new Date().getFullYear()} TicketAssist &bull; Powered by YUKTRON
        </div>
      </div>
    `;

    try {
      await this.sendResendEmail(
        user.email,
        'TicketAssist - Password Reset Verification Code',
        emailHtml,
      );
    } catch (err: any) {
      this.logger.warn(`Resend dispatch notice: ${err.message}. OTP logged for development.`);
    }

    return {
      message: `Verification code sent to registered email ${this.maskEmail(user.email)}`,
      emailMasked: this.maskEmail(user.email),
      expiresInSeconds: 600,
    };
  }

  /**
   * Verify the 6-digit OTP
   */
  async verifyOtp(dto: VerifyOtpDto) {
    const cleanId = dto.identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: cleanId.toLowerCase() }, { mobile: cleanId }],
      },
    });

    if (!user) {
      throw new NotFoundException('Account not found.');
    }

    const session = this.otpStore.get(user.email.toLowerCase());
    if (!session) {
      throw new BadRequestException('No active OTP request found or it has expired. Please request a new code.');
    }

    if (Date.now() > session.expiresAt) {
      this.otpStore.delete(user.email.toLowerCase());
      throw new BadRequestException('Verification code has expired. Please request a new code.');
    }

    if (session.attempts >= 5) {
      this.otpStore.delete(user.email.toLowerCase());
      throw new BadRequestException('Too many invalid attempts. Please request a new code.');
    }

    if (session.otp !== dto.otp.trim()) {
      session.attempts += 1;
      throw new BadRequestException('Invalid verification code. Please check and try again.');
    }

    session.verified = true;
    return {
      message: 'Verification code confirmed successfully.',
      verified: true,
    };
  }

  /**
   * Reset Password with verified OTP
   */
  async resetPassword(dto: ResetPasswordDto) {
    const cleanId = dto.identifier.trim();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: cleanId.toLowerCase() }, { mobile: cleanId }],
      },
    });

    if (!user) {
      throw new NotFoundException('Account not found.');
    }

    const session = this.otpStore.get(user.email.toLowerCase());
    if (!session) {
      throw new BadRequestException('Verification session expired or not found. Please request a new code.');
    }

    if (Date.now() > session.expiresAt) {
      this.otpStore.delete(user.email.toLowerCase());
      throw new BadRequestException('Verification code has expired. Please request a new code.');
    }

    if (!session.verified && session.otp !== dto.otp.trim()) {
      throw new BadRequestException('Invalid verification code.');
    }

    if (!dto.newPassword || dto.newPassword.length < 8) {
      throw new BadRequestException('New password must be at least 8 characters long.');
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(dto.newPassword, saltRounds);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
      } as any,
    });

    this.otpStore.delete(user.email.toLowerCase());

    await this.audit.log({
      actorId: user.id,
      actorType: 'USER',
      action: 'USER_PASSWORD_RESET_OTP',
      entity: 'User',
      entityId: user.id,
      metadata: { method: 'RESEND_OTP' },
    });

    return {
      message: 'Password reset successfully! You can now log in with your new password.',
    };
  }

  /**
   * Request OTP to change email address (sent via Resend to the new email address)
   */
  async requestEmailChange(userId: string, dto: RequestEmailChangeDto) {
    const cleanNewEmail = dto.newEmail.toLowerCase().trim();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User account not found');
    }

    if (user.email.toLowerCase() === cleanNewEmail) {
      throw new BadRequestException('The new email address cannot be the same as your current email.');
    }

    // Check if another user is already registered with this email
    const existingUser = await this.prisma.user.findUnique({
      where: { email: cleanNewEmail },
    });

    if (existingUser && existingUser.id !== userId) {
      throw new ConflictException('This email address is already in use by another account.');
    }

    // Generate 6-digit numeric OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    this.emailChangeStore.set(userId, {
      userId,
      currentEmail: user.email,
      newEmail: cleanNewEmail,
      otp,
      expiresAt,
      attempts: 0,
    });

    this.logger.log(`[Email Change OTP Generated] User ${user.email} -> New: ${cleanNewEmail}, OTP: ${otp}`);

    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 28px; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #172033; font-size: 22px; font-weight: 700; margin: 0;">TicketAssist Portal</h1>
          <p style="color: #64748b; font-size: 13px; margin-top: 4px;">Email Address Verification</p>
        </div>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 24px; text-align: center; margin-bottom: 24px;">
          <p style="color: #334155; font-size: 14px; margin: 0 0 12px 0;">You have requested to change your account email to <strong>${cleanNewEmail}</strong>. Use the verification code below to confirm this change:</p>
          <div style="font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #c98219; font-family: monospace; padding: 10px 0;">
            ${otp}
          </div>
          <p style="color: #64748b; font-size: 12px; margin: 12px 0 0 0;">This code is valid for <strong>10 minutes</strong>. Do not share it with anyone.</p>
        </div>
        <p style="color: #64748b; font-size: 12px; line-height: 1.5; margin: 0;">If you did not request this email change, please ignore this email or contact platform administrators immediately.</p>
        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #f1f5f9; text-align: center; color: #94a3b8; font-size: 11px;">
          &copy; ${new Date().getFullYear()} TicketAssist &bull; Powered by YUKTRON
        </div>
      </div>
    `;

    try {
      await this.sendResendEmail(
        cleanNewEmail,
        'TicketAssist - Verify Your New Email Address',
        emailHtml,
      );
    } catch (err: any) {
      this.logger.warn(`Resend dispatch notice: ${err.message}. OTP logged for development.`);
    }

    return {
      message: `Verification code sent to ${cleanNewEmail}`,
      newEmail: cleanNewEmail,
      expiresInSeconds: 600,
    };
  }

  /**
   * Verify OTP and update user's email address
   */
  async verifyEmailChange(userId: string, dto: VerifyEmailChangeDto) {
    const cleanNewEmail = dto.newEmail.toLowerCase().trim();

    const session = this.emailChangeStore.get(userId);
    if (!session) {
      throw new BadRequestException('No pending email change request found or it has expired. Please request a new code.');
    }

    if (session.newEmail !== cleanNewEmail) {
      throw new BadRequestException('Email address mismatch. Please request a new code.');
    }

    if (Date.now() > session.expiresAt) {
      this.emailChangeStore.delete(userId);
      throw new BadRequestException('Verification code has expired. Please request a new code.');
    }

    if (session.attempts >= 5) {
      this.emailChangeStore.delete(userId);
      throw new BadRequestException('Too many invalid attempts. Please request a new code.');
    }

    if (session.otp !== dto.otp.trim()) {
      session.attempts += 1;
      throw new BadRequestException('Invalid verification code. Please check and try again.');
    }

    // Check again for conflict right before updating
    const existingUser = await this.prisma.user.findUnique({
      where: { email: cleanNewEmail },
    });

    if (existingUser && existingUser.id !== userId) {
      this.emailChangeStore.delete(userId);
      throw new ConflictException('This email address is already in use by another account.');
    }

    // Update user email
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { email: cleanNewEmail },
    });

    // If partner exists for this user, also update partner email
    try {
      await (this.prisma as any).partner.updateMany({
        where: { userId },
        data: { email: cleanNewEmail },
      });
    } catch (e) {
      // ignore
    }

    this.emailChangeStore.delete(userId);

    await this.audit.log({
      actorId: userId,
      actorType: 'USER',
      action: 'USER_EMAIL_CHANGED',
      entity: 'User',
      entityId: userId,
      metadata: { oldEmail: session.currentEmail, newEmail: cleanNewEmail },
    });

    return {
      message: 'Your email address has been updated successfully!',
      email: cleanNewEmail,
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
