import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { WalletService } from './wallet.service';
import { JwtAuthGuard, RateLimiterGuard } from '../common/guards';
import { CurrentUser, Throttle } from '../common/decorators';
import { TopupDto, RequestRefundDto } from './dto/wallet.dto';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';

@Controller('wallet')
@UseGuards(JwtAuthGuard, RateLimiterGuard)
@UseInterceptors(IdempotencyInterceptor)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  async getWallet(@CurrentUser() user: any) {
    return this.walletService.getOrCreateWallet(user.id);
  }

  @Post('topup')
  @Throttle(10, 60)
  async topup(@CurrentUser() user: any, @Body() dto: TopupDto) {
    return this.walletService.topup(user.id, dto);
  }

  @Get('transactions')
  async getTransactions(
    @CurrentUser() user: any,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    return this.walletService.getTransactions(user.id, parseInt(page), parseInt(limit));
  }

  @Post('refund')
  @Throttle(5, 60)
  async requestRefund(@CurrentUser() user: any, @Body() dto: RequestRefundDto) {
    return this.walletService.requestRefund(user.id, dto);
  }
}
