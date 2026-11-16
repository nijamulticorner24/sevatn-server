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

  private resolveDistributorId(req: any): string {
    const distributorId = req.user?.distributorProfile?.id || req.user?.distributorId;
    if (!distributorId) {
      throw new BadRequestException('User is not associated with any Distributor account');
    }
    return distributorId;
  }

  @Get('overview')
  async getOverview(@Request() req: any) {
    const distributorId = this.resolveDistributorId(req);
    return this.distributorService.getDistributorOverview(distributorId);
  }

  @Get('profile')
  async getProfile(@Request() req: any) {
    const distributorId = this.resolveDistributorId(req);
    return this.distributorService.getDistributorProfile(distributorId);
  }

  @Get('centres')
  async getMyCentres(
    @Request() req: any,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('search') search?: string,
  ) {
    const distributorId = this.resolveDistributorId(req);
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
    const distributorId = this.resolveDistributorId(req);
    dto.expiresInMinutes = dto.expiresInMinutes || 30;
    return this.distributorService.generateCentreInvitation(distributorId, dto, req.user);
  }

  @Get('centres/invitations')
  async getCentreInvitations(@Request() req: any) {
    const distributorId = this.resolveDistributorId(req);
    return this.distributorService.getDistributorInvitations(distributorId);
  }

  @Post('centres/invitations/:id/regenerate')
  async regenerateCentreInvitation(
    @Request() req: any,
    @Param('id') id: string,
  ) {
    const distributorId = this.resolveDistributorId(req);
    return this.distributorService.regenerateCentreInvitation(distributorId, id, req.user);
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
}

