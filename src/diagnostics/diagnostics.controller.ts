import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { DiagnosticsService } from './diagnostics.service';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators';
import { Role } from '@prisma/client';

@Controller('diagnostics')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class DiagnosticsController {
  constructor(private readonly diagnosticsService: DiagnosticsService) {}

  @Get('audit')
  async analyzeFleetAndLogs() {
    return this.diagnosticsService.analyzeFleetAndLogs();
  }

  @Get('analytics')
  async getAdvancedAnalytics(
    @Query('range') range?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('service') service?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('userSegment') userSegment?: string,
  ) {
    return this.diagnosticsService.getAdvancedAnalytics({
      range,
      startDate,
      endDate,
      service,
      status,
      search,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      userSegment,
    });
  }

  @Get('user/:id')
  async getUserActivityDetail(@Param('id') id: string) {
    return this.diagnosticsService.getUserActivityDetail(id);
  }
}
