import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  UseGuards,
  Query,
} from '@nestjs/common';
import { CentresService } from './centres.service';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { CurrentUser, Roles } from '../common/decorators';
import { Role } from '@prisma/client';
import { CreateCentreDto, UpdateCentreDto } from './dto/centre.dto';

@Controller('centres')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CentresController {
  constructor(private readonly centresService: CentresService) {}

  @Get('me')
  async getMyCentre(@CurrentUser() user: any) {
    return this.centresService.getMyCentre(user.id);
  }

  @Get('stats/network')
  @Roles(Role.SUPER_ADMIN)
  async getNetworkStats() {
    return this.centresService.getNetworkStats();
  }

  @Get()
  @Roles(Role.SUPER_ADMIN)
  async getAllCentres(
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('district') district?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.centresService.getAllCentres(
      parseInt(page) || 1,
      parseInt(limit) || 50,
      district,
      status,
      search,
    );
  }

  @Post()
  @Roles(Role.SUPER_ADMIN)
  async createCentre(@CurrentUser() adminUser: any, @Body() dto: CreateCentreDto) {
    return this.centresService.createCentre(adminUser, dto);
  }

  @Get(':id')
  @Roles(Role.SUPER_ADMIN)
  async getCentreById(@Param('id') id: string) {
    return this.centresService.getCentreById(id);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN)
  async updateCentre(
    @CurrentUser() adminUser: any,
    @Param('id') id: string,
    @Body() dto: UpdateCentreDto,
  ) {
    return this.centresService.updateCentre(adminUser, id, dto);
  }

  @Post(':id/activate')
  @Roles(Role.SUPER_ADMIN)
  async activateCentre(@CurrentUser() adminUser: any, @Param('id') id: string) {
    return this.centresService.activateCentre(adminUser, id);
  }

  @Post(':id/suspend')
  @Roles(Role.SUPER_ADMIN)
  async suspendCentre(@CurrentUser() adminUser: any, @Param('id') id: string) {
    return this.centresService.suspendCentre(adminUser, id);
  }

  @Post(':id/reissue-activation')
  @Roles(Role.SUPER_ADMIN)
  async reissueActivation(@CurrentUser() adminUser: any, @Param('id') id: string) {
    return this.centresService.reissueActivation(adminUser, id);
  }
}

@Controller('admin/centres')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class AdminCentresController {
  constructor(private readonly centresService: CentresService) {}

  @Get()
  async getAllCentres(
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('district') district?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.centresService.getAllCentres(
      parseInt(page) || 1,
      parseInt(limit) || 50,
      district,
      status,
      search,
    );
  }

  @Post()
  async createCentre(@CurrentUser() adminUser: any, @Body() dto: CreateCentreDto) {
    return this.centresService.createCentre(adminUser, dto);
  }

  @Get(':id')
  async getCentreById(@Param('id') id: string) {
    return this.centresService.getCentreById(id);
  }

  @Patch(':id')
  async updateCentre(
    @CurrentUser() adminUser: any,
    @Param('id') id: string,
    @Body() dto: UpdateCentreDto,
  ) {
    return this.centresService.updateCentre(adminUser, id, dto);
  }

  @Post(':id/activate')
  async activateCentre(@CurrentUser() adminUser: any, @Param('id') id: string) {
    return this.centresService.activateCentre(adminUser, id);
  }

  @Post(':id/suspend')
  async suspendCentre(@CurrentUser() adminUser: any, @Param('id') id: string) {
    return this.centresService.suspendCentre(adminUser, id);
  }

  @Post(':id/reissue-activation')
  async reissueActivation(@CurrentUser() adminUser: any, @Param('id') id: string) {
    return this.centresService.reissueActivation(adminUser, id);
  }
}
