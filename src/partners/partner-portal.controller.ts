import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  BadRequestException,
} from '@nestjs/common';
import { PartnersService } from './partners.service';
import { GenerateInvitationDto } from './dto/partner.dto';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators';
import { Role } from '@prisma/client';

@Controller('partner')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.PARTNER, Role.SUPER_ADMIN)
export class PartnerPortalController {
  constructor(private partnersService: PartnersService) {}

  private resolvePartnerId(req: any): string {
    const partnerId = req.user?.partnerProfile?.id || req.user?.partnerId;
    if (!partnerId) {
      throw new BadRequestException('User is not attached to any partner franchise');
    }
    return partnerId;
  }

  /**
   * List all registered centres for the logged-in partner franchise
   */
  @Get('centres')
  async getMyCentres(
    @Request() req: any,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('district') district?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    const partnerId = this.resolvePartnerId(req);
    return this.partnersService.getPartnerCentres(
      partnerId,
      parseInt(page) || 1,
      parseInt(limit) || 50,
      district,
      status,
      search,
    );
  }

  /**
   * List all generated onboarding links for the logged-in partner
   */
  @Get('invitations')
  async getMyInvitations(@Request() req: any) {
    const partnerId = this.resolvePartnerId(req);
    return this.partnersService.getPartnerInvitations(partnerId);
  }

  /**
   * Generate a fresh 30-minute centre onboarding link
   */
  @Post('invitations')
  async createInvitation(@Request() req: any, @Body() dto: GenerateInvitationDto) {
    const partnerId = this.resolvePartnerId(req);
    // Force 30-minute expiry for partner onboarding link
    dto.expiresInMinutes = dto.expiresInMinutes || 30;
    return this.partnersService.generateInvitation(req.user, partnerId, dto);
  }

  /**
   * Regenerate an expired onboarding link with a fresh 30-minute token
   */
  @Post('invitations/:id/regenerate')
  async regenerateInvitation(@Request() req: any, @Param('id') id: string) {
    return this.partnersService.regenerateInvitation(req.user, id);
  }

  /**
   * Get partner earnings, balance, and payout history
   */
  @Get('payouts')
  async getMyPayouts(@Request() req: any) {
    const partnerId = this.resolvePartnerId(req);
    return this.partnersService.getPartnerPayouts(partnerId);
  }

  /**
   * Request UPI withdrawal / payout
   */
  @Post('payouts/request')
  async requestPayout(@Request() req: any, @Body() body: any) {
    const partnerId = this.resolvePartnerId(req);
    return this.partnersService.requestPayout(req.user, partnerId, body);
  }
}
