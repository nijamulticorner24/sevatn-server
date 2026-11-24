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
      const formattedAmount = `🪙 ${Number(payload.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
      const timeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

      let header = '<b>🔔 New Payment Submitted • Verification Required</b>';
      let actionUrl = 'http://localhost:3001/admin/ledger?tab=REGISTRATIONS';
      let actionLabel = 'Open Registrations in Financial Ledger';

      if (payload.paymentType === 'REFUND_REQUEST') {
        header = '<b>🔔 New Wallet Refund Requested • Settlement Required</b>';
        actionUrl = 'http://localhost:3001/admin/ledger?tab=REFUNDS';
        actionLabel = 'Open Refunds in Financial Ledger';
      } else if (payload.paymentType === 'WALLET_TOPUP') {
        header = payload.screenshotUrl
          ? '<b>🔔 New Wallet Top-Up Submitted • Verification Required</b>'
          : '<b>🔔 New Wallet Top-Up Received • Auto-Credited</b>';
        actionUrl = payload.screenshotUrl
          ? 'http://localhost:3001/admin/ledger?tab=PENDING'
          : 'http://localhost:3001/admin/ledger';
        actionLabel = 'Open Top-Ups in Financial Ledger';
      } else if (payload.paymentType === 'PARTNER_PAYOUT' || payload.paymentType === 'DISTRIBUTOR_PAYOUT') {
        header = '<b>🔔 New Earnings Payout Requested • Settlement Required</b>';
        actionUrl = 'http://localhost:3001/admin/payouts';
        actionLabel = 'Open Payouts in Admin Portal';
      } else if (!payload.screenshotUrl) {
        header = '<b>🔔 New Onboarding Fee Paid • Auto-Activated</b>';
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
      const formatCurr = (n: number) => `🪙 ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

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
   * Dispatches real-time Telegram notification for Central Booking Queue status transitions:
   * - New Booking Intake (isNew / NEW)
   * - Action Required (REQUIRES_HUMAN)
   * - Worker Error (WORKER_ERROR)
   * - Cancelled (CANCELLED)
   * - Success (SUCCESS, BOOKING_CONFIRMED, COMPLETED)
   */
  async sendTelegramBookingNotification(payload: {
    bookingId: string;
    bookingCode?: string;
    status: string;
    isNew?: boolean;
    previousStatus?: string;
    officialReference?: string;
    failureReason?: string;
    requiresHumanNote?: string;
    note?: string;
    workerId?: string;
    machineCode?: string;
    route?: string;
    requestedDate?: Date | string;
    selectedTime?: string;
    timeSlot?: string;
    pilgrimCount?: number;
    centreName?: string;
    operatorName?: string;
    district?: string;
    mobile?: string;
    screenshot?: string;
    screenshotUrl?: string;
  }) {
    try {
      const config = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
      if (!config || !config.telegramBotEnabled || !config.telegramBotToken || !config.telegramChatId) {
        return { skipped: true, reason: 'Telegram notifications not enabled or missing credentials' };
      }

      const botToken = config.telegramBotToken.trim();
      const chatId = config.telegramChatId.trim();

      let bookingData = { ...payload };
      if (!payload.route || !payload.centreName || !payload.bookingCode) {
        try {
          const br = await this.prisma.bookingRequest.findUnique({
            where: { id: payload.bookingId },
            include: {
              user: {
                include: {
                  centre: true,
                },
              },
              assignedMachine: true,
            },
          });
          if (br) {
            bookingData = {
              ...payload,
              bookingCode: payload.bookingCode || br.bookingCode,
              route: payload.route || br.route,
              requestedDate: payload.requestedDate || br.requestedDate,
              selectedTime: payload.selectedTime || (br as any).selectedTime || br.timeSlot || undefined,
              pilgrimCount: payload.pilgrimCount || br.pilgrimCount,
              officialReference: payload.officialReference || (br as any).officialBookingReference || (br as any).officialReference || undefined,
              failureReason: payload.failureReason || (br as any).failureReason || undefined,
              requiresHumanNote: payload.requiresHumanNote || (br as any).requiresHumanNote || undefined,
              centreName: payload.centreName || br.user?.centre?.centreName,
              operatorName: payload.operatorName || br.user?.name,
              district: payload.district || br.user?.centre?.district,
              mobile: payload.mobile || br.user?.mobile,
              machineCode: payload.machineCode || br.assignedMachine?.machineCode,
              screenshotUrl: payload.screenshotUrl || payload.screenshot || (br.confirmationEvidence as any)?.screenshot || undefined,
            };
          }
        } catch (dbErr: any) {
          this.logger.warn(`Could not load booking details for Telegram notification: ${dbErr.message}`);
        }
      }

      const bookingCode = bookingData.bookingCode || `#${payload.bookingId.slice(0, 8)}`;
      const timeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const actionUrl = `http://localhost:3001/admin/bookings`;
      const directBookingUrl = `http://localhost:3001/dashboard/bookings/${payload.bookingId}`;

      let header = '<b>🔔 Booking Status Update • Central Queue</b>';
      let statusLabel = String(payload.status);
      let detailsLine = '';

      const normalizedStatus = String(payload.status).toUpperCase();

      if (payload.isNew || normalizedStatus === 'NEW_BOOKING' || (normalizedStatus === 'NEW' && payload.isNew)) {
        header = '<b>🆕 NEW BOOKING RECEIVED • Central Booking Queue</b>';
        statusLabel = 'New Booking Queued';
        detailsLine = `📥 <b>Queue Status:</b> Received &amp; queued for Sabarimala slot discovery and auto-dispatch.`;
      } else if (normalizedStatus === 'REQUIRES_HUMAN') {
        header = '<b>⚠️ ACTION REQUIRED • Central Booking Queue</b>';
        statusLabel = 'Action Required';
        detailsLine = `⚠️ <b>Intervention:</b> ${bookingData.requiresHumanNote || bookingData.note || 'Manual review / captcha verification required on official portal.'}`;
      } else if (normalizedStatus === 'WORKER_ERROR') {
        header = '<b>🚨 WORKER ERROR • Central Booking Queue</b>';
        statusLabel = 'Worker Error';
        detailsLine = `❌ <b>Error Details:</b> ${bookingData.failureReason || bookingData.note || 'Automation process encountered an execution failure.'}`;
      } else if (normalizedStatus === 'CANCELLED') {
        header = '<b>🛑 BOOKING CANCELLED • Central Booking Queue</b>';
        statusLabel = 'Cancelled';
        detailsLine = `ℹ️ <b>Reason:</b> ${bookingData.note || bookingData.failureReason || 'Cancelled by operator / admin. Held deposit refunded.'}`;
      } else if (['BOOKING_FAILED', 'FAILED', 'EXECUTION_FAILED', 'WISHLIST_MISMATCH', 'RETRYABLE_FAILURE'].includes(normalizedStatus)) {
        header = '<b>🚨 BOOKING FLOW FAILED • Central Booking Queue</b>';
        statusLabel = 'Booking Flow Issue / Failed';
        detailsLine = `❌ <b>Error Details:</b> ${bookingData.failureReason || bookingData.note || 'Encountered issue during official Sabarimala booking flow.'}`;
      } else if (['SUCCESS', 'COMPLETED', 'BOOKING_CONFIRMED', 'CONFIRMED'].includes(normalizedStatus)) {
        header = '<b>✅ BOOKING CONFIRMED • Sabarimala Virtual Q Pass</b>';
        statusLabel = 'Confirmed / Success';
        const refStr = bookingData.officialReference || 'AUTHORITATIVE_CONFIRMED';
        detailsLine = `🎟 <b>Official Booking Ref:</b> <code>${refStr}</code>`;
      }

      const dateStr = bookingData.requestedDate
        ? new Date(bookingData.requestedDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
        : '';

      const lines = [
        header,
        ``,
        `🆔 <b>Booking ID:</b> <code>#${bookingCode}</code>`,
        `📊 <b>Status:</b> <b>${statusLabel}</b>`,
        detailsLine,
        bookingData.centreName ? `🏢 <b>Centre:</b> ${bookingData.centreName}` : '',
        bookingData.operatorName ? `👤 <b>Operator:</b> ${bookingData.operatorName}` : '',
        bookingData.district ? `📍 <b>District:</b> ${bookingData.district}` : '',
        bookingData.mobile ? `📞 <b>Contact:</b> <code>${bookingData.mobile}</code>` : '',
        bookingData.route ? `🛣 <b>Route:</b> ${bookingData.route}` : '',
        dateStr ? `📅 <b>Darshan Date:</b> ${dateStr}` : '',
        bookingData.selectedTime ? `⏰ <b>Time Slot:</b> ${bookingData.selectedTime}` : '',
        bookingData.pilgrimCount ? `👥 <b>Devotees:</b> ${bookingData.pilgrimCount} Pilgrim${bookingData.pilgrimCount !== 1 ? 's' : ''}` : '',
        bookingData.machineCode ? `💻 <b>Worker Machine:</b> <code>${bookingData.machineCode}</code>` : '',
        (payload.screenshot || payload.screenshotUrl || (bookingData as any).screenshot || (bookingData as any).screenshotUrl)
          ? `🌐 <b>Live Capture:</b> Official Portal (<code>sabarimalaonline.org</code>)`
          : '',
        ``,
        `⏱ <b>Alert Time:</b> ${timeStr} IST`,
        ``,
        `👉 <b>Central Queue:</b> <a href="${actionUrl}">Open Central Booking Queue &amp; Dispatch</a>`,
        `🔍 <b>Inspect Pass:</b> <a href="${directBookingUrl}">View Full Booking Record</a>`,
      ].filter(Boolean);

      const text = lines.join('\n');

      let sentPhoto = false;
      const screenshot =
        payload.screenshot ||
        payload.screenshotUrl ||
        (bookingData as any).screenshot ||
        (bookingData as any).screenshotUrl ||
        (bookingData as any).confirmationEvidence?.screenshot;

      if (screenshot) {
        try {
          let base64Data = screenshot;
          let mimeType = 'image/jpeg';
          if (screenshot.startsWith('data:')) {
            const matches = screenshot.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
              mimeType = matches[1];
              base64Data = matches[2];
            } else {
              base64Data = screenshot.replace(/^data:[^;]+;base64,/, '');
            }
          }

          let captionText = text;
          if (captionText.length > 1020) {
            captionText = captionText.slice(0, 990) + '...';
          }

          const formData = new FormData();
          formData.append('chat_id', chatId);

          if (screenshot.startsWith('http://') || screenshot.startsWith('https://')) {
            formData.append('photo', screenshot);
          } else {
            const buffer = Buffer.from(base64Data, 'base64');
            const blob = new Blob([buffer], { type: mimeType });
            formData.append('photo', blob, 'sabarimala_portal_issue.jpg');
          }

          formData.append('caption', captionText);
          formData.append('parse_mode', 'HTML');

          const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
            method: 'POST',
            body: formData,
          });
          const resJson: any = await res.json();
          if (resJson.ok) {
            sentPhoto = true;
            this.logger.log(`[Telegram Bot] Booking portal screenshot notification #${bookingCode} (${statusLabel}) dispatched to chat ${chatId}`);
          } else {
            this.logger.warn(`[Telegram Bot] sendPhoto returned not ok: ${JSON.stringify(resJson)}`);
          }
        } catch (photoErr: any) {
          this.logger.warn(`[Telegram Bot] Failed to send photo, falling back to text message: ${photoErr.message}`);
        }
      }

      if (!sentPhoto) {
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
        if (resJson.ok) {
          this.logger.log(`[Telegram Bot] Booking notification #${bookingCode} (${statusLabel}) dispatched to chat ${chatId}`);
        } else {
          this.logger.error(`[Telegram Bot] Failed to send booking notification: ${JSON.stringify(resJson)}`);
        }
        return { success: resJson.ok, response: resJson };
      } else if (text.length > 1020) {
        // If photo caption was truncated, follow up with the full details and action links
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: false,
          }),
        }).catch(() => {});
      }

      return { success: true };
    } catch (err: any) {
      this.logger.error(`[Telegram Booking Alert] Failed: ${err.message}`);
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
      `<b>🚀 TicketAssist Telegram Notifier Bot Connected!</b>`,
      ``,
      `Your notification bot is working properly.`,
      `Whenever a booking status changes in the <b>Central Booking Queue</b> (Action Required, Worker Error, Cancelled, Confirmed Success) or an onboarding payment/top-up is submitted, instant alerts will arrive here.`,
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
