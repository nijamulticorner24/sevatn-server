import {
  Controller,
  Get,
  Patch,
  Put,
  Body,
  Query,
  UseGuards,
  Request,
  BadRequestException,
} from '@nestjs/common';
import { TicketPricingService } from './ticket-pricing.service';
import { UpdatePricingConfigDto, UpdateMarkupDto } from './dto/pricing.dto';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles, CurrentUser } from '../common/decorators';
import { Role } from '@prisma/client';

@Controller()
export class PricingController {
  constructor(private readonly pricingService: TicketPricingService) {}

  // =========================================================================
  // 1. SUPER ADMIN PRICING CONFIGURATION
  // =========================================================================

  @Get('admin/pricing/config')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async getAdminPricingConfig() {
    return this.pricingService.getPricingConfig();
  }

  @Patch('admin/pricing/config')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async patchAdminPricingConfig(
    @CurrentUser() adminUser: any,
    @Body() dto: UpdatePricingConfigDto,
  ) {
    return this.pricingService.updatePricingConfig(adminUser, dto);
  }

  @Put('admin/pricing/config')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async putAdminPricingConfig(
    @CurrentUser() adminUser: any,
    @Body() dto: UpdatePricingConfigDto,
  ) {
    return this.pricingService.updatePricingConfig(adminUser, dto);
  }

  @Get('admin/pricing/audit')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async getPricingAuditLogs(@Query('limit') limit = '100') {
    return this.pricingService.getPricingAuditLogs(parseInt(limit, 10) || 100);
  }

  // =========================================================================
  // 2. PARTNER MARKUP CONFIGURATION
  // =========================================================================

  @Get('partner/markup')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.PARTNER, Role.SUPER_ADMIN)
  async getPartnerMarkup(@Request() req: any) {
    const partnerId = req.user?.partnerProfile?.id || req.user?.partnerId;
    if (!partnerId) {
      throw new BadRequestException('User is not associated with any Partner franchise');
    }
    return this.pricingService.getPartnerMarkup(partnerId);
  }

  @Patch('partner/markup')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.PARTNER, Role.SUPER_ADMIN)
  async updatePartnerMarkup(
    @Request() req: any,
    @Body() dto: UpdateMarkupDto,
  ) {
    const partnerId = req.user?.partnerProfile?.id || req.user?.partnerId;
    if (!partnerId) {
      throw new BadRequestException('User is not associated with any Partner franchise');
    }
    return this.pricingService.updatePartnerMarkup(partnerId, dto, req.user);
  }

  // =========================================================================
  // 3. DISTRIBUTOR MARKUP CONFIGURATION
  // =========================================================================

  @Get('distributor/markup')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.DISTRIBUTOR, Role.SUPER_ADMIN)
  async getDistributorMarkup(@Request() req: any) {
    const distributorId = req.user?.distributorProfile?.id || req.user?.distributorId;
    if (!distributorId) {
      throw new BadRequestException('User is not associated with any Distributor account');
    }
    return this.pricingService.getDistributorMarkup(distributorId);
  }

  @Patch('distributor/markup')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.DISTRIBUTOR, Role.SUPER_ADMIN)
  async updateDistributorMarkup(
    @Request() req: any,
    @Body() dto: UpdateMarkupDto,
  ) {
    const distributorId = req.user?.distributorProfile?.id || req.user?.distributorId;
    if (!distributorId) {
      throw new BadRequestException('User is not associated with any Distributor account');
    }
    return this.pricingService.updateDistributorMarkup(distributorId, dto, req.user);
  }

  // =========================================================================
  // 4. BOOKING PRICING PREVIEW (CENTRE / PUBLIC BREAKDOWN)
  // =========================================================================

  @Get('bookings/pricing/preview')
  @UseGuards(JwtAuthGuard)
  async previewBookingPricing(
    @CurrentUser() user: any,
    @Query('quantity') quantity = '1',
  ) {
    const parsedQty = Math.max(1, parseInt(quantity, 10) || 1);
    return this.pricingService.previewBookingPrice(user.id, parsedQty);
  }
}

