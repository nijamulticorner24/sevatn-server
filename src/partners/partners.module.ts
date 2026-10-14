import { Module } from '@nestjs/common';
import { PartnersService } from './partners.service';
import { PartnersController } from './partners.controller';
import { PartnerPortalController } from './partner-portal.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [PartnersService],
  controllers: [PartnersController, PartnerPortalController],
  exports: [PartnersService],
})
export class PartnersModule {}
