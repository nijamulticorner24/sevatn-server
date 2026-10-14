import { Controller, Get } from '@nestjs/common';
import { AdminService } from './admin.service';

@Controller('config')
export class PublicConfigController {
  constructor(private readonly adminService: AdminService) {}

  @Get('payment')
  async getPaymentConfig() {
    return this.adminService.getPublicPaymentConfig();
  }

  @Get('public')
  async getPublicConfig() {
    return this.adminService.getPublicPaymentConfig();
  }
}
