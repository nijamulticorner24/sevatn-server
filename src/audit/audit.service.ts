import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateAuditLogParams {
  actorId?: string;
  actorType: 'USER' | 'WORKER' | 'SYSTEM' | 'ADMIN';
  action: string;
  entity: string;
  entityId?: string;
  metadata?: any;
}

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async log(params: CreateAuditLogParams) {
    try {
      return await this.prisma.auditLog.create({
        data: {
          actorId: params.actorId,
          actorType: params.actorType,
          action: params.action,
          entity: params.entity,
          entityId: params.entityId,
          metadata: params.metadata || {},
        },
      });
    } catch (err) {
      console.error('AuditLog write error (non-fatal):', err);
    }
  }

  async getRecentLogs(limit = 50, entity?: string) {
    return this.prisma.auditLog.findMany({
      where: entity ? { entity } : undefined,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });
  }
}
