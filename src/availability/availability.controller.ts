import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Query,
} from '@nestjs/common';
import { AvailabilityService } from './availability.service';
import { MachineAuthGuard, JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators';
import { PublishAvailabilityDto, BulkPublishAvailabilityDto, ClaimDemandDto, ReleaseDemandDto } from './dto/availability.dto';
import { Role } from '@prisma/client';

@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availabilityService: AvailabilityService) {}

  /**
   * Worker fetches current date demand index to focus availability discovery
   */
  @Get('demand-dates')
  @UseGuards(MachineAuthGuard)
  async getDemandDates() {
    return this.availabilityService.getDemandDates();
  }

  /**
   * Worker atomically claims a discovery scan for a normalized demand key
   */
  @Post('claim-demand')
  @UseGuards(MachineAuthGuard)
  async claimDemand(@Body() dto: ClaimDemandDto) {
    return this.availabilityService.claimDemandScan(dto.demandKey, dto.workerId);
  }

  /**
   * Worker releases a discovery scan and updates scheduling interval policy
   */
  @Post('release-demand')
  @UseGuards(MachineAuthGuard)
  async releaseDemand(@Body() dto: ReleaseDemandDto) {
    return this.availabilityService.releaseDemandScan(
      dto.demandKey,
      dto.workerId,
      dto.status,
      dto.durationMs,
    );
  }

  /**
   * Discovery Engine runtime telemetry & observability metrics
   */
  @Get('metrics')
  @UseGuards(MachineAuthGuard)
  async getMetrics() {
    return this.availabilityService.getDiscoveryMetrics();
  }

  /**
   * Worker publishes a discovered date/time availability event
   */
  @Post('events')
  @UseGuards(MachineAuthGuard)
  async publishAvailability(@Body() dto: PublishAvailabilityDto) {
    return this.availabilityService.publishAvailability(dto);
  }

  /**
   * Worker publishes bulk discovered date/time availability events
   */
  @Post('events/bulk')
  @UseGuards(MachineAuthGuard)
  async publishBulkAvailability(@Body() dto: BulkPublishAvailabilityDto) {
    return this.availabilityService.publishBulkAvailability(dto.opportunities);
  }

  /**
   * Admin inspects recent availability opportunities
   */
  @Get('opportunities')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async getRecentOpportunities(@Query('limit') limit?: number) {
    return this.availabilityService.getRecentOpportunities(Number(limit) || 50);
  }
}
