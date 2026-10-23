import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { PartnersService } from './partners.service';
import { CreatePartnerDto, UpdatePartnerDto, GenerateInvitationDto } from './dto/partner.dto';
import { JwtAuthGuard, RolesGuard } from '../common/guards';
import { Roles } from '../common/decorators';
import { Role } from '@prisma/client';

@Controller('admin/partners')
export class PartnersController {
  constructor(private partnersService: PartnersService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async createPartner(@Request() req: any, @Body() dto: CreatePartnerDto) {
    return this.partnersService.createPartner(req.user, dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async getAllPartners(@Query() query: any) {
    return this.partnersService.getAllPartners(query);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async getPartnerById(@Param('id') id: string) {
    return this.partnersService.getPartnerById(id);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async updatePartner(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: UpdatePartnerDto,
  ) {
    return this.partnersService.updatePartner(req.user, id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async deletePartner(
    @Request() req: any,
    @Param('id') id: string,
  ) {
    return this.partnersService.deletePartner(req.user, id);
  }

  @Post(':id/invitations')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async generateInvitation(
    @Request() req: any,
    @Param('id') id: string,
    @Body() dto: GenerateInvitationDto,
  ) {
    return this.partnersService.generateInvitation(req.user, id, dto);
  }

  /**
   * Admin approves partner franchise payment and activates partner
   */
  @Post(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async approvePartner(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.partnersService.approvePartner(req.user, id, body?.notes);
  }

  @Post(':id/approve-payment')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async approvePartnerPayment(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.partnersService.approvePartner(req.user, id, body?.notes);
  }

  /**
   * Admin suspends/rejects a partner
   */
  @Post(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async rejectPartner(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.partnersService.rejectPartner(req.user, id, body?.reason);
  }

  /**
   * Public: Get partner onboarding info by token
   */
  @Get('onboard/:token')
  async getPartnerOnboardInfo(@Param('token') token: string) {
    return this.partnersService.getPartnerOnboardInfo(token);
  }

  /**
   * Public: Submit partner franchise payment reference
   */
  @Post('onboard/:token/pay')
  async submitPartnerPayment(
    @Param('token') token: string,
    @Body() dto: any,
  ) {
    return this.partnersService.submitPartnerPayment(token, dto);
  }

  /**
   * Admin lists all partner payout requests
   */
  @Get('payouts/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async getAllPayouts(@Query() query: any) {
    return this.partnersService.getAllAdminPayouts(query);
  }

  /**
   * Admin settles partner payout with screenshot & UTR reference
   */
  @Post('payouts/:id/settle')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  async settlePayout(
    @Request() req: any,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.partnersService.settlePartnerPayout(req.user, id, body);
  }
}
