import { Module } from '@nestjs/common';
import { InstantServiceService } from './instant-service.service';
import { InstantServiceController } from './instant-service.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [InstantServiceService],
  controllers: [InstantServiceController],
  exports: [InstantServiceService],
})
export class InstantServiceModule {}
