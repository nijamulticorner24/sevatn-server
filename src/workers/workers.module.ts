import { Module } from '@nestjs/common';
import { WorkersService } from './workers.service';
import { WorkersController } from './workers.controller';
import { WalletModule } from '../wallet/wallet.module';
import { AvailabilityModule } from '../availability/availability.module';

@Module({
  imports: [WalletModule, AvailabilityModule],
  controllers: [WorkersController],
  providers: [WorkersService],
  exports: [WorkersService],
})
export class WorkersModule {}
