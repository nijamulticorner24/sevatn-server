import { Module } from '@nestjs/common';
import { DistributorService } from './distributor.service';
import { DistributorController, AdminDistributorsController } from './distributor.controller';
import { PartnerDistributorsController } from './partner-distributors.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { PricingModule } from '../pricing/pricing.module';

@Module({
  imports: [PrismaModule, AuditModule, PricingModule],
  controllers: [
    DistributorController,
    AdminDistributorsController,
    PartnerDistributorsController,
  ],
  providers: [DistributorService],
  exports: [DistributorService],
})
export class DistributorModule {}

