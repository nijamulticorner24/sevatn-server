import { Module, forwardRef } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { BookingsController } from './bookings.controller';
import { AccountsService } from './accounts.service';
import { AccountsController } from './accounts.controller';
import { BookingStateMachineService } from './booking-state-machine.service';
import { WalletModule } from '../wallet/wallet.module';
import { AvailabilityModule } from '../availability/availability.module';
import { WorkersModule } from '../workers/workers.module';

@Module({
  imports: [WalletModule, AvailabilityModule, forwardRef(() => WorkersModule)],
  controllers: [BookingsController, AccountsController],
  providers: [BookingsService, AccountsService, BookingStateMachineService],
  exports: [BookingsService, AccountsService, BookingStateMachineService],
})
export class BookingsModule {}
