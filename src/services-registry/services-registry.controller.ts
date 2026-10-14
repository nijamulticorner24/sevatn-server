import {
  Controller,
  Get,
  Put,
  Param,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ServicesRegistryService } from './services-registry.service';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators';
import { Role } from '@prisma/client';

@Controller('services')
export class ServicesRegistryController {
  constructor(private servicesRegistry: ServicesRegistryService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  async getAvailableServices(@Request() req: any) {
    return this.servicesRegistry.getAvailableServices(req.user);
  }

  @Get(':code')
  @UseGuards(JwtAuthGuard)
  async getServiceByCode(@Param('code') code: string) {
    return this.servicesRegistry.getServiceByCode(code);
  }

  @Put('admin/:code')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async updateService(
    @Request() req: any,
    @Param('code') code: string,
    @Body() body: any,
  ) {
    return this.servicesRegistry.updateService(req.user, code, body);
  }
}
