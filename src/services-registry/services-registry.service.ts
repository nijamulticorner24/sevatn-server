import { Injectable, OnModuleInit, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class ServicesRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ServicesRegistryService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async onModuleInit() {
    await this.seedDefaultServices();
  }

  /**
   * Ensure default platform services are registered
   */
  async seedDefaultServices() {
    const defaultServices = [
      {
        code: 'TICKET_ASSIST',
        name: 'TicketAssist Sabarimala',
        description:
          'Automated & Assisted Sabarimala Darshan Virtual-Q booking assistance for eSevai / Computer Centres.',
        category: 'Pilgrim Booking Services',
        status: 'ACTIVE',
        config: {
          requiresLocationCheck: true,
          maxRadiusKm: 5,
          feePerBooking: 100,
        },
      },
      {
        code: 'INSTANT_SERVICE',
        name: 'Instant Service (Sevainest View)',
        description:
          'Official eSevai Certificate & Document status verification for Community, Income, Nativity, Patta/Chitta and Land records.',
        category: 'Citizen e-Governance',
        status: 'ACTIVE',
        config: {
          requiresLocationCheck: true,
          maxRadiusKm: 5,
          provider: 'Sevainest View API',
        },
      },
    ];

    for (const s of defaultServices) {
      const existing = await this.prisma.platformService.findUnique({
        where: { code: s.code },
      });
      if (!existing) {
        await this.prisma.platformService.create({
          data: s,
        });
        this.logger.log(`Registered platform service: ${s.code} (${s.name})`);
      }
    }
  }

  /**
   * Get all registered services
   */
  async getAvailableServices(user?: any) {
    const services = await this.prisma.platformService.findMany({
      orderBy: { createdAt: 'asc' },
    });

    return services.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      description: s.description,
      category: s.category,
      status: s.status,
      config: s.config,
      isAvailable: s.status === 'ACTIVE',
    }));
  }

  /**
   * Get single service definition
   */
  async getServiceByCode(code: string) {
    const service = await this.prisma.platformService.findUnique({
      where: { code: code.toUpperCase() },
    });
    if (!service) {
      throw new NotFoundException(`Service '${code}' not found`);
    }
    return service;
  }

  /**
   * Admin update service configuration/status
   */
  async updateService(adminUser: any, code: string, update: { name?: string; description?: string; status?: string; config?: any }) {
    const service = await this.prisma.platformService.findUnique({
      where: { code: code.toUpperCase() },
    });
    if (!service) {
      throw new NotFoundException(`Service '${code}' not found`);
    }

    const updated = await this.prisma.platformService.update({
      where: { code: code.toUpperCase() },
      data: {
        name: update.name || undefined,
        description: update.description || undefined,
        status: update.status || undefined,
        config: update.config !== undefined ? update.config : undefined,
      },
    });

    await this.audit.log({
      actorId: adminUser?.id,
      actorType: 'ADMIN',
      action: 'PLATFORM_SERVICE_UPDATED',
      entity: 'PlatformService',
      entityId: updated.id,
      metadata: { code, status: updated.status },
    });

    return updated;
  }
}
