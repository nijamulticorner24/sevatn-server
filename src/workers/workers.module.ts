import { Module } from '@nestjs/common';
import { WorkersService } from './workers.service';
import { WorkersController } from './workers.controller';
import { SmartAllocatorService } from './smart-allocator.service';
import { WalletModule } from '../wallet/wallet.module';
import { AvailabilityModule } from '../availability/availability.module';

@Module({
  imports: [WalletModule, AvailabilityModule],
  controllers: [WorkersController],
  providers: [WorkersService, SmartAllocatorService],
  exports: [WorkersService, SmartAllocatorService],
})
export class WorkersModule {}
