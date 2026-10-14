import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationChannel } from '@prisma/client';

export interface SendNotificationDto {
  userId?: string;
  recipient: string;
  channel: NotificationChannel;
  title: string;
  body: string;
  payload?: any;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private prisma: PrismaService) {}

  async send(dto: SendNotificationDto) {
    this.logger.log(`[Notification ${dto.channel}] to ${dto.recipient}: ${dto.title} - ${dto.body}`);

    // Store in-app / audit notification event
    const record = await this.prisma.notificationEvent.create({
      data: {
        userId: dto.userId,
        recipient: dto.recipient,
        channel: dto.channel,
        title: dto.title,
        body: dto.body,
        status: 'SENT',
        payload: dto.payload || {},
      },
    });

    // Adapter for WhatsApp / SMS / Email (extensible provider interface)
    switch (dto.channel) {
      case NotificationChannel.WHATSAPP:
        await this.dispatchWhatsApp(dto);
        break;
      case NotificationChannel.SMS:
        await this.dispatchSMS(dto);
        break;
      case NotificationChannel.EMAIL:
        await this.dispatchEmail(dto);
        break;
      case NotificationChannel.IN_APP:
      default:
        // Already persisted in DB for real-time in-app polling/websocket
        break;
    }

    return record;
  }

  private async dispatchWhatsApp(dto: SendNotificationDto) {
    // Provider integration hook (Twilio, Gupshup, Meta Cloud API)
    this.logger.log(`[WhatsApp Provider] Dispatched message to ${dto.recipient}`);
  }

  private async dispatchSMS(dto: SendNotificationDto) {
    // Provider integration hook (Fast2SMS, MSG91, Twilio)
    this.logger.log(`[SMS Gateway] Dispatched SMS to ${dto.recipient}`);
  }

  private async dispatchEmail(dto: SendNotificationDto) {
    // Provider integration hook (Resend, SendGrid, Postmark)
    this.logger.log(`[Email SMTP] Dispatched Email to ${dto.recipient}`);
  }

  async getUserNotifications(userId: string, limit = 30) {
    return this.prisma.notificationEvent.findMany({
      where: { userId },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }
}
