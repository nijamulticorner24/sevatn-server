import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { CentresModule } from './centres/centres.module';
import { WalletModule } from './wallet/wallet.module';
import { BookingsModule } from './bookings/bookings.module';
import { AvailabilityModule } from './availability/availability.module';
import { WorkersModule } from './workers/workers.module';
import { RefundsModule } from './refunds/refunds.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AuditModule } from './audit/audit.module';
import { AdminModule } from './admin/admin.module';
import { DiagnosticsModule } from './diagnostics/diagnostics.module';
import { PartnersModule } from './partners/partners.module';
import { ServicesRegistryModule } from './services-registry/services-registry.module';
import { InstantServiceModule } from './instant-service/instant-service.module';
import { EventsModule } from './events/events.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuditModule,
    EventsModule,
    NotificationsModule,
    AuthModule,
    CentresModule,
    WalletModule,
    BookingsModule,
    AvailabilityModule,
    WorkersModule,
    RefundsModule,
    AdminModule,
    DiagnosticsModule,
    PartnersModule,
    ServicesRegistryModule,
    InstantServiceModule,
  ],
})
export class AppModule {}
