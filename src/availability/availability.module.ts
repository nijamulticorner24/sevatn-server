import { Module } from '@nestjs/common';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';
import { SmartMatcherService } from './smart-matcher.service';
import { AccountLockService } from './account-lock.service';

@Module({
  controllers: [AvailabilityController],
  providers: [
    AvailabilityService,
    SmartMatcherService,
    AccountLockService,
  ],
  exports: [
    AvailabilityService,
    SmartMatcherService,
    AccountLockService,
  ],
})
export class AvailabilityModule {}
