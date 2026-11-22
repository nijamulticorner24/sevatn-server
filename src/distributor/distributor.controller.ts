import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  BadRequestException,
} from '@nestjs/common';
import { DistributorService } from './distributor.service';
import { GenerateCentreInvitationDto } from './dto/distributor.dto';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators';
import { Role } from '@prisma/client';

@Controller('distributor')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.DISTRIBUTOR, Role.SUPER_ADMIN)
export class DistributorController {
  constructor(private readonly distributorService: DistributorService) {}

  private async resolveDistributorId(req: any): Promise<string> {
    return this.distributorService.resolveDistributorIdForUser(req.user);
  }

  @Get('overview')
  async getOverview(@Request() req: any) {
    const distributorId = await this.resolveDistributorId(req);
    return this.distributorService.getDistributorOverview(distributorId);
  }

  @Get('profile')
  async getProfile(@Request() req: any) {
    const distributorId = await this.resolveDistributorId(req);
    return this.distributorService.getDistributorProfile(distributorId);
  }

  @Get('centres')
  async getMyCentres(
    @Request() req: any,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('search') search?: string,
  ) {
    const distributorId = await this.resolveDistributorId(req);
    return this.distributorService.getDistributorCentres(
      distributorId,
      parseInt(page, 10) || 1,
      parseInt(limit, 10) || 50,
      search,
    );
  }

  @Post('centres/invitations')
  async createCentreInvitation(
    @Request() req: any,
    @Body() dto: GenerateCentreInvitationDto,
  ) {
    const distributorId = await this.resolveDistributorId(req);
    dto.expiresInMinutes = dto.expiresInMinutes || 30;
    return this.distributorService.generateCentreInvitation(distributorId, dto, req.user);
  }

  @Get('centres/invitations')
  async getCentreInvitations(@Request() req: any) {
    const distributorId = await this.resolveDistributorId(req);
    return this.distributorService.getDistributorInvitations(distributorId);
  }

  @Post('centres/invitations/:id/regenerate')
  async regenerateCentreInvitation(
    @Request() req: any,
    @Param('id') id: string,
  ) {
    const distributorId = await this.resolveDistributorId(req);
    return this.distributorService.regenerateCentreInvitation(distributorId, id, req.user);
  }

  /**
   * Distributor shares / transfers wallet balance to one of their network Centres
   */
  @Post('wallet/transfer-to-centre')
  async transferWalletToCentre(
    @Request() req: any,
    @Body() dto: { centreId: string; amount: number; notes?: string },
  ) {
    const distributorId = await this.resolveDistributorId(req);
    return this.distributorService.transferWalletToCentre(req.user, distributorId, dto);
  }

  /**
   * Distributor gets own earnings summary and payout history
   */
  @Get('payouts')
  async getMyPayouts(@Request() req: any) {
    const distributorId = await this.resolveDistributorId(req);
    return this.distributorService.getDistributorPayouts(distributorId);
  }

  /**
   * Distributor requests UPI payout / withdrawal
   */
  @Post('payouts/request')
  async requestPayout(@Request() req: any, @Body() body: any) {
    const distributorId = await this.resolveDistributorId(req);
    return this.distributorService.requestDistributorPayout(req.user, distributorId, body);
  }
}

@Controller('admin/distributors')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class AdminDistributorsController {
  constructor(private readonly distributorService: DistributorService) {}

  @Get()
  async getAllDistributorsAdmin(@Query() query: any) {
    return this.distributorService.getAllDistributorsAdmin(query);
  }

  /**
   * Super Admin lists all distributor payout requests
   */
  @Get('payouts/all')
  async getAllDistributorPayouts(@Query() query: any) {
    return this.distributorService.getAllDistributorPayoutsAdmin(query);
  }

  /**
   * Super Admin settles a distributor payout request
   */
  @Post('payouts/:id/settle')
  async settleDistributorPayout(
    @Param('id') id: string,
    @Body() dto: { paymentReference: string; adminNotes?: string; screenshotUrl?: string },
    @Request() req: any,
  ) {
    return this.distributorService.settleDistributorPayout(id, dto, req.user);
  }

  /**
   * Super Admin adjusts a distributor's wallet balance (CREDIT or DEBIT)
   */
  @Post(':id/wallet-adjust')
  async adjustDistributorWallet(
    @Param('id') id: string,
    @Body() dto: { amount: number; action: 'CREDIT' | 'DEBIT'; reason?: string },
    @Request() req: any,
  ) {
    return this.distributorService.adjustDistributorWallet(req.user, id, dto);
  }

  /**
   * Super Admin permanently deletes a distributor
   */
  @Delete(':id')
  async deleteDistributor(@Param('id') id: string, @Request() req: any) {
    return this.distributorService.deleteDistributor(req.user, id);
  }
}

