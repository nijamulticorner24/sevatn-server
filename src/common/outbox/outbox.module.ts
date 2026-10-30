import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { EventsModule } from '../../events/events.module';
import { PrismaModule } from '../../prisma/prisma.module';

@Module({
  imports: [PrismaModule, EventsModule],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}

