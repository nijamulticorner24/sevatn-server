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

@Injectable()
export class ServiceAccessGuard implements CanActivate {
  private readonly logger = new Logger(ServiceAccessGuard.name);

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

    // Superadmins bypass location checks for operational oversight
    if (user.role === Role.SUPER_ADMIN || user.role === Role.WORKER) {
      return true;
    }

    // 1. Fetch live user record & registered location
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

    // 4. Validate Registered Location exists
    if (!dbUser.registeredLocation) {
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

    // If client provided location context, validate it
    if (currentLat !== null && currentLon !== null) {
      const coordValidation = isValidCoordinate({
        latitude: currentLat,
        longitude: currentLon,
        accuracy: currentAccuracy ?? undefined,
      });

      if (!coordValidation.valid) {
        throw new BadRequestException(`Location validation failed: ${coordValidation.reason}`);
      }

      // 6. Compute Haversine Distance
      const distanceKm = calculateHaversineDistanceKm(
        { latitude: currentLat, longitude: currentLon },
        {
          latitude: dbUser.registeredLocation.latitude,
          longitude: dbUser.registeredLocation.longitude,
        },
      );

      const MAX_ALLOWED_KM = 5.0;

      if (distanceKm > MAX_ALLOWED_KM) {
        this.logger.warn(
          `[LOCATION_ACCESS_DENIED] User ${dbUser.email} is ${distanceKm} KM away (Max: ${MAX_ALLOWED_KM} KM)`,
        );

        await this.audit.log({
          actorId: dbUser.id,
          actorType: 'USER',
          action: 'LOCATION_ACCESS_DENIED',
          entity: 'RegisteredLocation',
          entityId: dbUser.registeredLocation.id,
          metadata: {
            distanceKm,
            maxAllowedKm: MAX_ALLOWED_KM,
            currentLocation: { lat: currentLat, lon: currentLon },
            registeredLocation: {
              lat: dbUser.registeredLocation.latitude,
              lon: dbUser.registeredLocation.longitude,
            },
          },
        });

        throw new ForbiddenException(
          `Access Denied: You are ${distanceKm} KM away from your registered service location. Access is permitted strictly within a ${MAX_ALLOWED_KM} KM radius under SevaTN security policy.`,
        );
      }

      // Location access permitted
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
      };
    }

    return true;
  }

  private extractCoordinate(...candidates: any[]): number | null {
    for (const c of candidates) {
      if (c !== undefined && c !== null && c !== '') {
        const val = Number(c);
        if (!isNaN(val)) return val;
      }
    }
    return null;
  }
}
