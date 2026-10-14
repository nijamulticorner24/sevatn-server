import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { JwtAuthGuard } from '../common/guards';
import { CurrentUser } from '../common/decorators';
import { CreateAccountDto, VerifyAccountDto } from './dto/account.dto';

@Controller('booking/accounts')
@UseGuards(JwtAuthGuard)
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Post()
  async saveAccount(@CurrentUser() user: any, @Body() dto: CreateAccountDto) {
    return this.accountsService.saveAccount(user.id, dto);
  }

  @Post('verify')
  async verifyAccount(@CurrentUser() user: any, @Body() dto: VerifyAccountDto) {
    return this.accountsService.verifyAccount(user.id, dto);
  }

  @Get()
  async listAccounts(@CurrentUser() user: any) {
    return this.accountsService.listAccounts(user.id);
  }

  @Get(':id')
  async getAccountById(@Param('id') id: string, @CurrentUser() user: any) {
    return this.accountsService.getAccountById(id, user.id);
  }

  @Delete(':id')
  async deleteAccount(@Param('id') id: string, @CurrentUser() user: any) {
    return this.accountsService.deleteAccount(id, user.id);
  }
}
