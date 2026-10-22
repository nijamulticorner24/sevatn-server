import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ServiceAccessGuard } from '../common/guards/service-access.guard';
import { isValidCoordinate, calculateHaversineDistanceKm } from '../common/utils/geo';
import { EventsGateway } from '../events/events.gateway';
import { Role, UserStatus } from '@prisma/client';

describe('Location Validation & ServiceAccessGuard Suite', () => {
  let authService: AuthService;
  let guard: ServiceAccessGuard;
  let prisma: PrismaService;
  let reflector: Reflector;

  const mockPrisma = {
    registeredLocation: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    centre: {
      findUnique: jest.fn(),
    },
    platformService: {
      findUnique: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
  };

  const mockAudit = {
    log: jest.fn().mockResolvedValue({}),
  };

  const mockNotifications = {
    notifyUser: jest.fn(),
  };

  const mockJwt = {
    sign: jest.fn(),
    verify: jest.fn(),
  };

  const mockConfig = {
    get: jest.fn(),
  };

  const mockEventsGateway = {
    server: { emit: jest.fn() },
    emitToUser: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        ServiceAccessGuard,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: JwtService, useValue: mockJwt },
        { provide: ConfigService, useValue: mockConfig },
        { provide: EventsGateway, useValue: mockEventsGateway },
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn().mockReturnValue(null),
          },
        },
      ],
    }).compile();

    authService = module.get<AuthService>(AuthService);
    guard = module.get<ServiceAccessGuard>(ServiceAccessGuard);
    prisma = module.get<PrismaService>(PrismaService);
    reflector = module.get<Reflector>(Reflector);
  });

  // =========================================================================
  // 1. Coordinate Sanity & Accuracy Boundary Tests (isValidCoordinate)
  // =========================================================================
  describe('1. Coordinate Sanity & Accuracy Boundaries', () => {
    it('accepts valid GPS coordinates with high accuracy (15m)', () => {
      const result = isValidCoordinate({ latitude: 13.0067, longitude: 80.2024, accuracy: 15 });
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('accepts GPS coordinates at the 2,500m threshold', () => {
      const result = isValidCoordinate({ latitude: 13.0067, longitude: 80.2024, accuracy: 2500 });
      expect(result.valid).toBe(true);
    });

    it('rejects poor accuracy (50,000m) with descriptive reason', () => {
      const result = isValidCoordinate({ latitude: 13.0067, longitude: 80.2024, accuracy: 50000 });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Location accuracy too low (50000m). Must be under 2500m.');
    });

    it('rejects boundary-exceeding accuracy (2,501m)', () => {
      const result = isValidCoordinate({ latitude: 13.0067, longitude: 80.2024, accuracy: 2501 });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Must be under 2500m');
    });

    it('rejects out of range latitude (> 90)', () => {
      const result = isValidCoordinate({ latitude: 95.0, longitude: 80.2024 });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Latitude out of range [-90, +90]');
    });

    it('rejects out of range longitude (> 180)', () => {
      const result = isValidCoordinate({ latitude: 13.0067, longitude: 185.0 });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Longitude out of range [-180, +180]');
    });

    it('rejects Null Island (0,0)', () => {
      const result = isValidCoordinate({ latitude: 0, longitude: 0 });
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Coordinates at Null Island (0,0) are disallowed');
    });

    it('rejects missing or NaN coordinates', () => {
      expect(isValidCoordinate({ latitude: NaN, longitude: 80.2024 }).valid).toBe(false);
      expect(isValidCoordinate({ latitude: 13.0067, longitude: undefined as any }).valid).toBe(false);
    });
  });

  // =========================================================================
  // 2. AuthService Location Persistence & Lock Enforcement
  // =========================================================================
  describe('2. AuthService Location Persistence & Lock Enforcement', () => {
    it('successfully persists default RegisteredLocation on initial registration (no prior location)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: Role.CENTRE });
      mockPrisma.registeredLocation.findUnique.mockResolvedValue(null); // No prior location

      const mockSavedLocation = {
        id: 'loc-1',
        userId: 'user-1',
        latitude: 13.0067,
        longitude: 80.2024,
        accuracy: 15,
        address: '123 Anna Salai',
        district: 'Chennai',
        status: 'ACTIVE',
        capturedAt: new Date(),
      };
      mockPrisma.registeredLocation.upsert.mockResolvedValue(mockSavedLocation);

      const res = await authService.updateLocation('user-1', {
        latitude: 13.0067,
        longitude: 80.2024,
        accuracy: 15,
        address: '123 Anna Salai',
        district: 'Chennai',
      });

      expect(res.message).toBe('Default service location registered and locked successfully');
      expect(res.location.latitude).toBe(13.0067);
      expect(mockPrisma.registeredLocation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
          create: expect.objectContaining({ latitude: 13.0067, longitude: 80.2024, accuracy: 15 }),
        }),
      );
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'LOCATION_REGISTERED',
          entityId: 'loc-1',
        }),
      );
    });

    it('rejects subsequent location changes by operator when location is already registered (Locked for Security)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', role: Role.CENTRE });
      mockPrisma.registeredLocation.findUnique.mockResolvedValue({
        id: 'loc-1',
        userId: 'user-1',
        latitude: 13.0067,
        longitude: 80.2024,
      });

      await expect(
        authService.updateLocation('user-1', {
          latitude: 13.0500,
          longitude: 80.2500,
          accuracy: 20,
        }),
      ).rejects.toThrow(ForbiddenException);

      expect(mockPrisma.registeredLocation.upsert).not.toHaveBeenCalled();
    });

    it('allows SUPER_ADMIN to modify location even if already registered', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'admin-1', role: Role.SUPER_ADMIN });
      mockPrisma.registeredLocation.findUnique.mockResolvedValue({
        id: 'loc-1',
        userId: 'admin-1',
        latitude: 13.0067,
        longitude: 80.2024,
      });

      const mockUpdatedLocation = {
        id: 'loc-1',
        userId: 'admin-1',
        latitude: 13.0500,
        longitude: 80.2500,
        accuracy: 20,
        status: 'ACTIVE',
        capturedAt: new Date(),
      };
      mockPrisma.registeredLocation.upsert.mockResolvedValue(mockUpdatedLocation);

      const res = await authService.updateLocation('admin-1', {
        latitude: 13.0500,
        longitude: 80.2500,
        accuracy: 20,
      });

      expect(res.message).toBe('Service location updated successfully');
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'LOCATION_UPDATED',
          actorType: 'ADMIN',
        }),
      );
    });

    it('throws BadRequestException when accuracy is 50,000m and does NOT persist', async () => {
      await expect(
        authService.updateLocation('user-1', {
          latitude: 13.0067,
          longitude: 80.2024,
          accuracy: 50000,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockPrisma.registeredLocation.upsert).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. ServiceAccessGuard Enforcements
  // =========================================================================
  describe('3. ServiceAccessGuard Enforcements', () => {
    const createMockContext = (user: any, headers: Record<string, string> = {}) => {
      const request = {
        user,
        headers,
        body: {},
        query: {},
      };
      return {
        switchToHttp: () => ({
          getRequest: () => request,
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      } as unknown as ExecutionContext;
    };

    it('throws 403 Forbidden when user has NO registered service location', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        email: 'operator@test.com',
        status: UserStatus.ACTIVE,
        role: Role.CENTRE,
        registeredLocation: null, // Not configured
      });

      const context = createMockContext({ id: 'u-1', role: Role.CENTRE });

      await expect(guard.canActivate(context)).rejects.toThrow(
        new ForbiddenException(
          'Registered service location not configured. Please set your service location in profile before accessing services.',
        ),
      );
    });

    it('allows access when operator is within 5 KM radius (e.g. 1.25 km)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        email: 'operator@test.com',
        status: UserStatus.ACTIVE,
        role: Role.CENTRE,
        registeredLocation: {
          id: 'loc-1',
          latitude: 13.0067,
          longitude: 80.2024,
        },
      });

      // Operator GPS is ~1.25 km away
      const context = createMockContext(
        { id: 'u-1', role: Role.CENTRE },
        {
          'x-user-latitude': '13.0150',
          'x-user-longitude': '80.2100',
          'x-user-accuracy': '20',
        },
      );

      const result = await guard.canActivate(context);
      expect(result).toBe(true);
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'LOCATION_ACCESS_ALLOWED' }),
      );
    });

    it('throws 403 Forbidden when operator is outside 5 KM radius (e.g. 21.4 km away)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        email: 'operator@test.com',
        status: UserStatus.ACTIVE,
        role: Role.CENTRE,
        registeredLocation: {
          id: 'loc-1',
          latitude: 13.0067,
          longitude: 80.2024,
        },
      });

      // Operator GPS is ~21.4 km away
      const context = createMockContext(
        { id: 'u-1', role: Role.CENTRE },
        {
          'x-user-latitude': '13.2000',
          'x-user-longitude': '80.2024',
          'x-user-accuracy': '25',
        },
      );

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'LOCATION_ACCESS_DENIED' }),
      );
    });

    it('throws BadRequestException when client passes low accuracy header (50,000m)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        email: 'operator@test.com',
        status: UserStatus.ACTIVE,
        role: Role.CENTRE,
        registeredLocation: {
          id: 'loc-1',
          latitude: 13.0067,
          longitude: 80.2024,
        },
      });

      const context = createMockContext(
        { id: 'u-1', role: Role.CENTRE },
        {
          'x-user-latitude': '13.0067',
          'x-user-longitude': '80.2024',
          'x-user-accuracy': '50000',
        },
      );

      await expect(guard.canActivate(context)).rejects.toThrow(BadRequestException);
    });

    it('throws 403 Forbidden when centre operator omits mandatory GPS coordinates', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        email: 'operator@test.com',
        status: UserStatus.ACTIVE,
        role: Role.CENTRE,
        registeredLocation: {
          id: 'loc-1',
          latitude: 13.0067,
          longitude: 80.2024,
          status: 'ACTIVE',
        },
      });

      // Headers omitted completely
      const context = createMockContext({ id: 'u-1', role: Role.CENTRE }, {});

      await expect(guard.canActivate(context)).rejects.toThrow(
        /Location validation failed: Current GPS latitude and longitude .* are mandatory/
      );
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'LOCATION_MISSING_DENIED' })
      );
    });

    it('throws BadRequestException when coordinates are malformed/non-numeric strings', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        email: 'operator@test.com',
        status: UserStatus.ACTIVE,
        role: Role.CENTRE,
        registeredLocation: {
          id: 'loc-1',
          latitude: 13.0067,
          longitude: 80.2024,
          status: 'ACTIVE',
        },
      });

      const context = createMockContext(
        { id: 'u-1', role: Role.CENTRE },
        { 'x-user-latitude': 'not-a-number', 'x-user-longitude': '80.2024' }
      );

      await expect(guard.canActivate(context)).rejects.toThrow(
        /Malformed coordinate value 'not-a-number'/
      );
    });

    it('throws 403 Forbidden when user account is SUSPENDED', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        email: 'suspended@test.com',
        status: UserStatus.SUSPENDED,
        role: Role.CENTRE,
        registeredLocation: { id: 'loc-1', latitude: 13.0067, longitude: 80.2024, status: 'ACTIVE' },
      });

      const context = createMockContext({ id: 'u-1', role: Role.CENTRE }, {
        'x-user-latitude': '13.0067',
        'x-user-longitude': '80.2024',
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        /Your SevaTN account is suspended/
      );
    });

    it('throws 403 Forbidden when user account is PAYMENT_PENDING', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        email: 'pending@test.com',
        status: UserStatus.PAYMENT_PENDING,
        role: Role.CENTRE,
        registeredLocation: { id: 'loc-1', latitude: 13.0067, longitude: 80.2024, status: 'ACTIVE' },
      });

      const context = createMockContext({ id: 'u-1', role: Role.CENTRE }, {
        'x-user-latitude': '13.0067',
        'x-user-longitude': '80.2024',
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        /Account activation payment is pending/
      );
    });

    it('throws 403 Forbidden when user account license has EXPIRED', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'u-1',
        email: 'expired@test.com',
        status: UserStatus.EXPIRED,
        role: Role.CENTRE,
        registeredLocation: { id: 'loc-1', latitude: 13.0067, longitude: 80.2024, status: 'ACTIVE' },
      });

      const context = createMockContext({ id: 'u-1', role: Role.CENTRE }, {
        'x-user-latitude': '13.0067',
        'x-user-longitude': '80.2024',
      });

      await expect(guard.canActivate(context)).rejects.toThrow(
        /Your operational license has expired/
      );
    });

    it('bypasses location validation for WORKER and PARTNER roles', async () => {
      const workerContext = createMockContext({ id: 'worker-1', role: Role.WORKER });
      expect(await guard.canActivate(workerContext)).toBe(true);

      const partnerContext = createMockContext({ id: 'partner-1', role: Role.PARTNER });
      expect(await guard.canActivate(partnerContext)).toBe(true);
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('bypasses location validation for SUPER_ADMIN role', async () => {
      const context = createMockContext({ id: 'admin-1', role: Role.SUPER_ADMIN });
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
      expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. Geolocation Error Mapping (Frontend Scenarios Simulation)
  // =========================================================================
  describe('4. Geolocation Error Mapping', () => {
    function mapGeolocationError(err: { code: number; message: string }): string {
      switch (err.code) {
        case 1: // PERMISSION_DENIED
          return 'Location permission denied. Please allow location access in your browser settings to sync your centre GPS.';
        case 2: // POSITION_UNAVAILABLE
          return 'Location position unavailable. Please ensure your device has location/GPS services enabled or connect to Wi-Fi.';
        case 3: // TIMEOUT
          return 'Location request timed out. Please try again.';
        default:
          return `GPS Error: ${err.message}`;
      }
    }

    it('correctly formats PERMISSION_DENIED error', () => {
      const msg = mapGeolocationError({ code: 1, message: 'User denied Geolocation' });
      expect(msg).toContain('Location permission denied');
    });

    it('correctly formats POSITION_UNAVAILABLE error', () => {
      const msg = mapGeolocationError({ code: 2, message: 'Network location provider failed' });
      expect(msg).toContain('Location position unavailable');
    });

    it('correctly formats TIMEOUT error', () => {
      const msg = mapGeolocationError({ code: 3, message: 'Timeout expired' });
      expect(msg).toContain('Location request timed out');
    });
  });
});
