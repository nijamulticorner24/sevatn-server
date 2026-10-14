import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { RefundsService } from './refunds.service';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { CurrentUser, Roles } from '../common/decorators';
import { RefundStatus, Role } from '@prisma/client';

@Controller('refunds')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RefundsController {
  constructor(private readonly refundsService: RefundsService) {}

  @Get()
  async getRefunds(@CurrentUser() user: any, @Query('status') status?: RefundStatus) {
    return this.refundsService.getRefunds(user, status);
  }

  @Post(':id/process')
  @Roles(Role.SUPER_ADMIN)
  async processRefund(
    @Param('id') id: string,
    @Body() body: { action: 'APPROVE' | 'REJECT'; adminNotes?: string; reference?: string; proofUrl?: string },
    @CurrentUser() admin: any,
  ) {
    return this.refundsService.processRefund(
      id,
      body.action,
      {
        adminNotes: body.adminNotes,
        reference: body.reference,
        proofUrl: body.proofUrl,
      },
      admin,
    );
  }
}
