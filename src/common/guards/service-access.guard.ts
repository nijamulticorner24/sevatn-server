import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { calculateHaversineDistanceKm, isValidCoordinate } from '../utils/geo';
import { REQUIRE_SERVICE_KEY } from '../decorators/require-service.decorator';
import { UserStatus, Role } from '@prisma/client';

/**
 * ServiceAccessGuard enforces:
 * 1. Account status validation (Active, fee paid, non-expired, non-suspended)
 * 2. Platform Service activation state (via @RequireService decorator)
 * 3. SevaTN 5 KM Geofencing Access Control for Centre Operators:
 *    - Mandatory GPS coordinates (x-user-latitude, x-user-longitude)
 *    - Coordinate sanity checks (range, NaN/non-finite, Null Island, accuracy limit)
 *    - Haversine distance verification against trusted registered centre coordinates
 * 4. Documented exceptions:
 *    - SUPER_ADMIN: platform-wide operational oversight
 *    - WORKER: distributed automation terminals
 *    - PARTNER: regional franchise management (not in-centre citizen operations)
 *
 * NOTE ON SECURITY LIMITATION:
 * Client-supplied GPS headers can be manipulated by malicious clients (e.g. via proxy or curl).
 * While accuracy boundaries (< 2500m) and coordinate sanity checks are strictly enforced,
 * client headers do not constitute hardware-level cryptographic proof of physical location.
 * Every location evaluation (permitted and denied) is logged to the immutable audit trail.
 */
@Injectable()
export class ServiceAccessGuard implements CanActivate {
  private readonly logger = new Logger(ServiceAccessGuard.name);
  public static readonly MAX_ALLOWED_KM = 5.0;

  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !user.id) {
      throw new ForbiddenException('Authentication required');
    }

    // Explicit documented exceptions: Super Admin, Worker, Partner franchise managers
    if (user.role === Role.SUPER_ADMIN || user.role === Role.WORKER || user.role === Role.PARTNER) {
      return true;
    }

    // 1. Fetch live user record & registered location from trusted database
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.id },
      include: {
        registeredLocation: true,
      },
    });

    if (!dbUser) {
      throw new ForbiddenException('User account not found');
    }

    // 2. Validate Account Status
    if (dbUser.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('Your SevaTN account is suspended. Please contact your authorized partner.');
    }
    if (dbUser.status === UserStatus.PAYMENT_PENDING) {
      throw new ForbiddenException('Account activation payment is pending. Please complete registration payment.');
    }
    if (dbUser.status === UserStatus.EXPIRED) {
      throw new ForbiddenException('Your operational license has expired. Please renew with your partner.');
    }

    // 3. Validate Service Requirement (if decorated)
    const requiredServiceCode = this.reflector.getAllAndOverride<string>(
      REQUIRE_SERVICE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredServiceCode) {
      const service = await this.prisma.platformService.findUnique({
        where: { code: requiredServiceCode.toUpperCase() },
      });

      if (!service || service.status !== 'ACTIVE') {
        await this.audit.log({
          actorId: dbUser.id,
          actorType: 'USER',
          action: 'SERVICE_ACCESS_DENIED',
          entity: 'PlatformService',
          entityId: service?.id,
          metadata: { serviceCode: requiredServiceCode, reason: 'Service disabled or unavailable' },
        });
        throw new ForbiddenException(`Service '${requiredServiceCode}' is currently under maintenance or disabled.`);
      }
    }

    // 4. Validate Registered Centre Location exists and is not disabled
    if (!dbUser.registeredLocation || (dbUser.registeredLocation.status && dbUser.registeredLocation.status !== 'ACTIVE')) {
      throw new ForbiddenException(
        'Registered service location not configured. Please set your service location in profile before accessing services.',
      );
    }

    // 5. Extract Current Location from Request Headers or Body
    const currentLat = this.extractCoordinate(
      request.headers['x-user-latitude'],
      request.body?.latitude,
      request.query?.latitude,
    );
    const currentLon = this.extractCoordinate(
      request.headers['x-user-longitude'],
      request.body?.longitude,
      request.query?.longitude,
    );
    const currentAccuracy = this.extractCoordinate(
      request.headers['x-user-accuracy'],
      request.body?.accuracy,
      request.query?.accuracy,
    );

    // 6. Mandatory Geofencing Enforcement for Centre Operators
    if (currentLat === null || currentLon === null) {
      await this.audit.log({
        actorId: dbUser.id,
        actorType: 'USER',
        action: 'LOCATION_MISSING_DENIED',
        entity: 'RegisteredLocation',
        entityId: dbUser.registeredLocation.id,
        metadata: {
          reason: 'Mandatory GPS coordinates header missing on protected service route',
          hasLat: currentLat !== null,
          hasLon: currentLon !== null,
        },
      });

      throw new ForbiddenException(
        'Location validation failed: Current GPS latitude and longitude (x-user-latitude, x-user-longitude) ' +
          'are mandatory for centre service operations under SevaTN 5 KM security policy. Please ensure location services are enabled.',
      );
    }

    // 7. Validate Coordinate Sanity (Range [-90,+90] & [-180,+180], Null Island (0,0), Accuracy limit)
    const coordValidation = isValidCoordinate({
      latitude: currentLat,
      longitude: currentLon,
      accuracy: currentAccuracy ?? undefined,
    });

    if (!coordValidation.valid) {
      throw new BadRequestException(`Location validation failed: ${coordValidation.reason}`);
    }

    // 8. Compute Great-Circle Haversine Distance
    const distanceKm = calculateHaversineDistanceKm(
      { latitude: currentLat, longitude: currentLon },
      {
        latitude: dbUser.registeredLocation.latitude,
        longitude: dbUser.registeredLocation.longitude,
      },
    );

    if (distanceKm > ServiceAccessGuard.MAX_ALLOWED_KM) {
      this.logger.warn(
        `[LOCATION_ACCESS_DENIED] Centre ${dbUser.email} is ${distanceKm} KM away from registered base (Max: ${ServiceAccessGuard.MAX_ALLOWED_KM} KM)`,
      );

      await this.audit.log({
        actorId: dbUser.id,
        actorType: 'USER',
        action: 'LOCATION_ACCESS_DENIED',
        entity: 'RegisteredLocation',
        entityId: dbUser.registeredLocation.id,
        metadata: {
          distanceKm,
          maxAllowedKm: ServiceAccessGuard.MAX_ALLOWED_KM,
          currentLocation: { lat: currentLat, lon: currentLon },
          registeredLocation: {
            lat: dbUser.registeredLocation.latitude,
            lon: dbUser.registeredLocation.longitude,
          },
        },
      });

      throw new ForbiddenException(
        `Access Denied: You are ${distanceKm} KM away from your registered service location. ` +
          `Access is permitted strictly within a ${ServiceAccessGuard.MAX_ALLOWED_KM} KM radius under SevaTN security policy.`,
      );
    }

    // 9. Location Access Permitted - Record in Audit Trail
    await this.audit.log({
      actorId: dbUser.id,
      actorType: 'USER',
      action: 'LOCATION_ACCESS_ALLOWED',
      entity: 'RegisteredLocation',
      entityId: dbUser.registeredLocation.id,
      metadata: { distanceKm, withinRadius: true },
    });

    request.locationContext = {
      distanceKm,
      withinRadius: true,
      latitude: currentLat,
      longitude: currentLon,
      accuracy: currentAccuracy,
    };

    return true;
  }

  private extractCoordinate(...candidates: any[]): number | null {
    for (const c of candidates) {
      if (c !== undefined && c !== null && c !== '') {
        const val = Number(c);
        if (!isNaN(val) && Number.isFinite(val)) return val;
        throw new BadRequestException(`Malformed coordinate value '${c}'. Valid numeric coordinate is required.`);
      }
    }
    return null;
  }
}
