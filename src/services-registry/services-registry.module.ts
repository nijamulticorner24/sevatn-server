import { Module } from '@nestjs/common';
import { ServicesRegistryService } from './services-registry.service';
import { ServicesRegistryController } from './services-registry.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [ServicesRegistryService],
  controllers: [ServicesRegistryController],
  exports: [ServicesRegistryService],
})
export class ServicesRegistryModule {}
