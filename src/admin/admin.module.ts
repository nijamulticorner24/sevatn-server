import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { PublicConfigController } from './public-config.controller';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [WalletModule],
  controllers: [AdminController, PublicConfigController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
