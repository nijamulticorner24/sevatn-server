import { Module } from '@nestjs/common';
import { CentresService } from './centres.service';
import { CentresController, AdminCentresController } from './centres.controller';

@Module({
  controllers: [CentresController, AdminCentresController],
  providers: [CentresService],
  exports: [CentresService],
})
export class CentresModule {}
