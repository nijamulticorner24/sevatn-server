import { Module } from '@nestjs/common';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';
import { SmartMatcherService } from './smart-matcher.service';
import { AccountLockService } from './account-lock.service';
import { DiscoverySchedulerService } from './discovery-scheduler.service';

@Module({
  controllers: [AvailabilityController],
  providers: [
    AvailabilityService,
    SmartMatcherService,
    AccountLockService,
    DiscoverySchedulerService,
  ],
  exports: [
    AvailabilityService,
    SmartMatcherService,
    AccountLockService,
    DiscoverySchedulerService,
  ],
})
export class AvailabilityModule {}
