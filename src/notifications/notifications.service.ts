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

  /**
   * Dispatches real-time Telegram notification to configured Bot / Chat
   */
  async sendTelegramPaymentNotification(payload: {
    paymentType: string;
    amount: number;
    paymentReference?: string;
    screenshotUrl?: string;
    applicantName?: string;
    entityName?: string;
    entityCode?: string;
    district?: string;
    mobile?: string;
    email?: string;
    role?: string;
  }) {
    try {
      const config = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
      if (!config || !config.telegramBotEnabled || !config.telegramBotToken || !config.telegramChatId) {
        return { skipped: true, reason: 'Telegram notifications not enabled or missing credentials' };
      }

      const botToken = config.telegramBotToken.trim();
      const chatId = config.telegramChatId.trim();

      const typeTitles: Record<string, string> = {
        CENTRE_ONBOARDING: '🏢 Centre Onboarding License',
        DISTRIBUTOR_LICENSE: '📦 Distributor Territorial License',
        PARTNER_FRANCHISE: '🤝 Partner Franchise License',
        WALLET_TOPUP: '💳 Centre Wallet Top-Up',
        REFUND_REQUEST: '🔄 Centre Wallet Refund Request',
        PARTNER_PAYOUT: '💸 Partner Earnings Payout Request',
        DISTRIBUTOR_PAYOUT: '💸 Distributor Earnings Payout Request',
      };

      const title = typeTitles[payload.paymentType] || payload.paymentType;
      const refStr = payload.paymentReference || 'RECEIPT_PROOF_ATTACHED';
      const formattedAmount = `₹${Number(payload.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
      const timeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

      let header = '<b>🔔 New Payment Submitted • Verification Required</b>';
      let actionUrl = 'http://localhost:3001/admin/ledger?tab=REGISTRATIONS';
      let actionLabel = 'Open Registrations in Financial Ledger';

      if (payload.paymentType === 'REFUND_REQUEST') {
        header = '<b>🔔 New Wallet Refund Requested • Settlement Required</b>';
        actionUrl = 'http://localhost:3001/admin/ledger?tab=REFUNDS';
        actionLabel = 'Open Refunds in Financial Ledger';
      } else if (payload.paymentType === 'WALLET_TOPUP') {
        header = '<b>🔔 New Wallet Top-Up Submitted • Verification Required</b>';
        actionUrl = 'http://localhost:3001/admin/ledger?tab=PENDING';
        actionLabel = 'Open Top-Ups in Financial Ledger';
      } else if (payload.paymentType === 'PARTNER_PAYOUT' || payload.paymentType === 'DISTRIBUTOR_PAYOUT') {
        header = '<b>🔔 New Earnings Payout Requested • Settlement Required</b>';
        actionUrl = 'http://localhost:3001/admin/payouts';
        actionLabel = 'Open Payouts in Admin Portal';
      }

      const captionLines = [
        header,
        ``,
        `💰 <b>Amount:</b> <code>${formattedAmount}</code>`,
        `🏷 <b>Category:</b> ${title}`,
        payload.entityName ? `🏢 <b>Entity:</b> ${payload.entityName}${payload.entityCode ? ` (<code>${payload.entityCode}</code>)` : ''}` : '',
        payload.applicantName ? `👤 <b>Applicant:</b> ${payload.applicantName}` : '',
        payload.district ? `📍 <b>District:</b> ${payload.district}` : '',
        payload.mobile ? `📞 <b>Mobile:</b> <code>${payload.mobile}</code>` : '',
        payload.email ? `✉️ <b>Email:</b> ${payload.email}` : '',
        `🔢 <b>Reference / UPI:</b> <code>${refStr}</code>`,
        payload.screenshotUrl ? `📸 <b>Receipt Proof:</b> ✅ Attached` : '',
        ``,
        `⏱ <b>Time:</b> ${timeStr} IST`,
        ``,
        `👉 <b>Action:</b> <a href="${actionUrl}">${actionLabel}</a>`,
      ].filter(Boolean);

      const captionText = captionLines.join('\n');

      // Attempt to send as photo if screenshot exists
      let sentPhoto = false;
      if (payload.screenshotUrl && payload.screenshotUrl.startsWith('data:image/')) {
        try {
          const mimeMatch = payload.screenshotUrl.match(/^data:(image\/\w+);base64,/);
          const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
          const base64Data = payload.screenshotUrl.replace(/^data:image\/\w+;base64,/, '');
          const buffer = Buffer.from(base64Data, 'base64');
          const blob = new Blob([buffer], { type: mimeType });

          const formData = new FormData();
          formData.append('chat_id', chatId);
          formData.append('photo', blob, 'receipt.jpg');
          formData.append('caption', captionText);
          formData.append('parse_mode', 'HTML');

          const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
            method: 'POST',
            body: formData,
          });
          const resJson: any = await res.json();
          if (resJson.ok) {
            sentPhoto = true;
            this.logger.log(`[Telegram Bot] Payment photo notification sent successfully to chat ${chatId}`);
          } else {
            this.logger.warn(`[Telegram Bot] sendPhoto returned not ok: ${JSON.stringify(resJson)}`);
          }
        } catch (photoErr: any) {
          this.logger.warn(`[Telegram Bot] Failed to send photo, falling back to message: ${photoErr.message}`);
        }
      }

      // If photo was not sent, send as text message
      if (!sentPhoto) {
        const msgRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: captionText,
            parse_mode: 'HTML',
            disable_web_page_preview: false,
          }),
        });
        const msgJson: any = await msgRes.json();
        if (msgJson.ok) {
          this.logger.log(`[Telegram Bot] Payment message notification sent successfully to chat ${chatId}`);
        } else {
          this.logger.error(`[Telegram Bot] sendMessage error: ${JSON.stringify(msgJson)}`);
        }
      }

      return { success: true };
    } catch (err: any) {
      this.logger.error(`[Telegram Bot] Failed to dispatch payment notification: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Dispatches financial ledger pending items summary to Telegram
   */
  async sendTelegramLedgerPendingSummary(summary: {
    pendingTopupsCount?: number;
    pendingTopupsAmount?: number;
    pendingCentresCount?: number;
    pendingCentresAmount?: number;
    pendingPartnersCount?: number;
    pendingPartnersAmount?: number;
    pendingDistributorsCount?: number;
    pendingDistributorsAmount?: number;
    pendingRefundsCount?: number;
    pendingRefundsAmount?: number;
    pendingPayoutsCount?: number;
    pendingPayoutsAmount?: number;
  }) {
    try {
      const config = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
      if (!config || !config.telegramBotEnabled || !config.telegramBotToken || !config.telegramChatId) {
        return { skipped: true, reason: 'Telegram notifications not enabled or missing credentials' };
      }

      const botToken = config.telegramBotToken.trim();
      const chatId = config.telegramChatId.trim();

      const topupsCount = Number(summary.pendingTopupsCount || 0);
      const topupsAmount = Number(summary.pendingTopupsAmount || 0);
      const centresCount = Number(summary.pendingCentresCount || 0);
      const centresAmount = Number(summary.pendingCentresAmount || 0);
      const partnersCount = Number(summary.pendingPartnersCount || 0);
      const partnersAmount = Number(summary.pendingPartnersAmount || 0);
      const distributorsCount = Number(summary.pendingDistributorsCount || 0);
      const distributorsAmount = Number(summary.pendingDistributorsAmount || 0);
      const refundsCount = Number(summary.pendingRefundsCount || 0);
      const refundsAmount = Number(summary.pendingRefundsAmount || 0);
      const payoutsCount = Number(summary.pendingPayoutsCount || 0);
      const payoutsAmount = Number(summary.pendingPayoutsAmount || 0);

      const totalItems = topupsCount + centresCount + partnersCount + distributorsCount + refundsCount + payoutsCount;
      const totalAmount = topupsAmount + centresAmount + partnersAmount + distributorsAmount + refundsAmount + payoutsAmount;

      if (totalItems === 0) {
        return { success: true, message: 'No pending ledger items to notify.' };
      }

      const timeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const formatCurr = (n: number) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

      const lines = [
        `<b>📋 Financial Ledger • Pending Action Items Alert</b>`,
        ``,
        `⚠️ <b>Total Pending Items:</b> <code>${totalItems}</code> (${formatCurr(totalAmount)})`,
        ``,
        topupsCount > 0 ? `💳 <b>Wallet Top-ups:</b> ${topupsCount} awaiting approval (<code>${formatCurr(topupsAmount)}</code>)` : '',
        centresCount > 0 ? `🏢 <b>Centre Registrations:</b> ${centresCount} awaiting verification (<code>${formatCurr(centresAmount)}</code>)` : '',
        distributorsCount > 0 ? `📦 <b>Distributor Licenses:</b> ${distributorsCount} awaiting approval (<code>${formatCurr(distributorsAmount)}</code>)` : '',
        partnersCount > 0 ? `🤝 <b>Partner Franchises:</b> ${partnersCount} awaiting approval (<code>${formatCurr(partnersAmount)}</code>)` : '',
        refundsCount > 0 ? `🔄 <b>Refund Requests:</b> ${refundsCount} awaiting settlement (<code>${formatCurr(refundsAmount)}</code>)` : '',
        payoutsCount > 0 ? `💸 <b>Payout Requests:</b> ${payoutsCount} awaiting settlement (<code>${formatCurr(payoutsAmount)}</code>)` : '',
        ``,
        `⏱ <b>Alert Time:</b> ${timeStr} IST`,
        ``,
        `👉 <b>Action:</b> <a href="http://localhost:3001/admin/ledger">Open Financial Ledger in Admin Portal</a>`,
      ].filter(Boolean);

      const text = lines.join('\n');

      const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: false,
        }),
      });

      const resJson: any = await res.json();
      return { success: resJson.ok, response: resJson };
    } catch (err: any) {
      this.logger.error(`[Telegram Ledger Alert] Failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Test Telegram connection with provided credentials or stored config
   */
  async testTelegramNotification(botToken?: string, chatId?: string) {
    let token = botToken?.trim();
    let chat = chatId?.trim();

    if (!token || !chat) {
      const config = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
      token = token || config?.telegramBotToken?.trim();
      chat = chat || config?.telegramChatId?.trim();
    }

    if (!token || !chat) {
      throw new Error('Please enter both Telegram Bot API Token and Telegram Chat ID.');
    }

    const timeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const text = [
      `<b>🚀 TicketAssist Telegram Bot Connected!</b>`,
      ``,
      `Your payment notification bot is working properly.`,
      `Whenever a centre, distributor, or partner completes an onboarding payment or wallet top-up, instant alerts will arrive here.`,
      ``,
      `⏱ <b>Test Time:</b> ${timeStr} IST`,
    ].join('\n');

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text,
        parse_mode: 'HTML',
      }),
    });

    const resJson: any = await res.json();
    if (!resJson.ok) {
      throw new Error(resJson.description || 'Telegram API returned an error.');
    }

    return {
      success: true,
      message: 'Test notification sent successfully to Telegram!',
      chatId: chat,
    };
  }
}
