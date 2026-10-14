import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { InstantServiceService } from './instant-service.service';
import { JwtAuthGuard, ServiceAccessGuard } from '../common/guards';
import { RequireService } from '../common/decorators';

@Controller('instant-service')
export class InstantServiceController {
  constructor(private instantService: InstantServiceService) {}

  @Get('types')
  async getAvailableTypes() {
    return this.instantService.getAvailableServiceTypes();
  }

  @Post('query')
  @UseGuards(JwtAuthGuard, ServiceAccessGuard)
  @RequireService('INSTANT_SERVICE')
  async queryApplication(
    @Request() req: any,
    @Body() body: { serviceType: string; applicationNumber: string; latitude?: number; longitude?: number },
  ) {
    return this.instantService.queryApplication(
      req.user.id,
      body.serviceType,
      body.applicationNumber,
    );
  }

  @Get('history')
  @UseGuards(JwtAuthGuard)
  async getQueryHistory(@Request() req: any) {
    return this.instantService.getQueryHistory(req.user.id);
  }
}
