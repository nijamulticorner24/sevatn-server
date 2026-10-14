import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { AuditService } from '../audit/audit.service';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles, CurrentUser } from '../common/decorators';
import { Role } from '@prisma/client';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly auditService: AuditService,
  ) {}

  @Get('dashboard')
  async getDashboardMetrics() {
    return this.adminService.getDashboardMetrics();
  }

  @Get('config')
  async getSystemConfig() {
    return this.adminService.getSystemConfig();
  }

  @Put('config')
  async updateSystemConfig(@Body() body: any) {
    return this.adminService.updateSystemConfig(body);
  }

  @Get('audit-logs')
  async getAuditLogs() {
    return this.auditService.getRecentLogs(100);
  }

  @Post('queues/clear-all')
  async clearAllQueues(@CurrentUser() user: any) {
    return this.adminService.clearAllQueues(user);
  }

  // --- Dedicated Financial Ledger & Payments Collection APIs ---

  @Get('ledger/overview')
  async getLedgerOverview() {
    return this.adminService.getLedgerOverview();
  }

  @Get('ledger/transactions')
  async getLedgerTransactions(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.adminService.getLedgerTransactions({
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 25,
      status,
      type,
      search,
      dateFrom,
      dateTo,
    });
  }

  @Post('ledger/transactions/:id/verify')
  async verifyTopupTransaction(
    @CurrentUser() adminUser: any,
    @Param('id') id: string,
  ) {
    return this.adminService.verifyTopupTransaction(adminUser, id);
  }

  @Post('ledger/transactions/:id/reject')
  async rejectTopupTransaction(
    @CurrentUser() adminUser: any,
    @Param('id') id: string,
    @Body('reason') reason?: string,
  ) {
    return this.adminService.rejectTopupTransaction(adminUser, id, reason);
  }

  @Post('ledger/centre-fee/:id/verify')
  async verifyCentreRegistrationFee(
    @CurrentUser() adminUser: any,
    @Param('id') id: string,
  ) {
    return this.adminService.verifyCentreRegistrationFee(adminUser, id);
  }

  @Post('ledger/centre-fee/:id/reject')
  async rejectCentreRegistrationFee(
    @CurrentUser() adminUser: any,
    @Param('id') id: string,
    @Body('reason') reason?: string,
  ) {
    return this.adminService.rejectCentreRegistrationFee(adminUser, id, reason);
  }

  @Post('ledger/partner-fee/:id/verify')
  async verifyPartnerFranchiseFee(
    @CurrentUser() adminUser: any,
    @Param('id') id: string,
    @Body('notes') notes?: string,
  ) {
    return this.adminService.verifyPartnerFranchiseFee(adminUser, id, notes);
  }

  @Post('ledger/partner-fee/:id/reject')
  async rejectPartnerFranchiseFee(
    @CurrentUser() adminUser: any,
    @Param('id') id: string,
    @Body('reason') reason?: string,
  ) {
    return this.adminService.rejectPartnerFranchiseFee(adminUser, id, reason);
  }
}
