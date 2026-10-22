import { Module } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { BookingsController } from './bookings.controller';
import { AccountsService } from './accounts.service';
import { AccountsController } from './accounts.controller';
import { WalletModule } from '../wallet/wallet.module';
import { AvailabilityModule } from '../availability/availability.module';
import { WorkersModule } from '../workers/workers.module';

@Module({
  imports: [WalletModule, AvailabilityModule, WorkersModule],
  controllers: [BookingsController, AccountsController],
  providers: [BookingsService, AccountsService],
  exports: [BookingsService, AccountsService],
})
export class BookingsModule {}
