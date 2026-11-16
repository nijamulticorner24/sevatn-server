import { Module, Global } from '@nestjs/common';
import { TicketPricingService } from './ticket-pricing.service';
import { PricingController } from './pricing.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [PricingController],
  providers: [TicketPricingService],
  exports: [TicketPricingService],
})
export class PricingModule {}

