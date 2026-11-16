import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
  BadRequestException,
} from '@nestjs/common';
import { DistributorService } from './distributor.service';
import {
  CreateDistributorDto,
  UpdateDistributorDto,
  UpdateDistributorStatusDto,
} from './dto/distributor.dto';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators';
import { Role } from '@prisma/client';

@Controller('partner/distributors')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.PARTNER, Role.SUPER_ADMIN)
export class PartnerDistributorsController {
  constructor(private readonly distributorService: DistributorService) {}

  private resolvePartnerId(req: any): string {
    const partnerId = req.user?.partnerProfile?.id || req.user?.partnerId;
    if (!partnerId) {
      throw new BadRequestException('User is not associated with any Partner franchise');
    }
    return partnerId;
  }

  @Post()
  async createDistributor(@Request() req: any, @Body() dto: CreateDistributorDto) {
    const partnerId = this.resolvePartnerId(req);
    return this.distributorService.createDistributor(req.user, partnerId, dto);
  }

  @Get()
  async getMyDistributors(@Request() req: any, @Query() query: any) {
    const partnerId = this.resolvePartnerId(req);
    return this.distributorService.getPartnerDistributors(partnerId, query);
  }

  @Get(':id')
  async getDistributorById(@Request() req: any, @Param('id') id: string) {
    const partnerId = this.resolvePartnerId(req);
    return this.distributorService.getPartnerDistributorById(partnerId, id);
  }

  @Patch(':id')
  async updateDistributor(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateDistributorDto,
  ) {
    const partnerId = this.resolvePartnerId(req);
    return this.distributorService.updateDistributor(partnerId, id, dto, req.user);
  }

  @Patch(':id/status')
  async updateDistributorStatus(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateDistributorStatusDto,
  ) {
    const partnerId = this.resolvePartnerId(req);
    return this.distributorService.updateDistributorStatus(partnerId, id, dto, req.user);
  }
}

