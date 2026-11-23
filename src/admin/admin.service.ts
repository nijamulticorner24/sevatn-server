import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { BookingStateMachineService } from '../bookings/booking-state-machine.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  BookingStatus,
  UserStatus,
  WorkerStatus,
  TransactionType,
  TransactionStatus,
  CentreStatus,
  PayoutStatus,
  RefundStatus,
  PartnerStatus,
  InvitationStatus,
  Prisma,
} from '@prisma/client';
import { NotFoundException, BadRequestException } from '@nestjs/common';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private prisma: PrismaService,
    private walletService: WalletService,
    private notifications: NotificationsService,
    @Optional() private stateMachine?: BookingStateMachineService,
  ) {}

  async getDashboardMetrics() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [
      totalCentres,
      activeCentres,
      expiredCentres,
      totalUsers,
      totalWorkers,
      onlineWorkers,
      busyWorkers,
      bookingsByStatus,
      financials,
      systemConfig,
      walletsSum,
      totalPartners,
      activePartners,
      totalDistributors,
      activeDistributors,
      todayBookingsCount,
      recentBookings,
      recentCentres,
      workerList,
    ] = await Promise.all([
      this.prisma.centre.count(),
      this.prisma.centre.count({ where: { status: 'ACTIVE' } }),
      this.prisma.user.count({ where: { status: UserStatus.EXPIRED } }),
      this.prisma.user.count(),
      this.prisma.workerMachine.count(),
      this.prisma.workerMachine.count({ where: { status: WorkerStatus.ONLINE, active: true } }),
      this.prisma.workerMachine.count({ where: { status: WorkerStatus.BUSY, active: true } }),
      this.prisma.bookingRequest.groupBy({
        by: ['status'],
        _count: { id: true },
      }),
      this.walletService.getFinancialLedgerSummary(),
      this.getSystemConfig(),
      this.prisma.wallet.aggregate({
        _sum: {
          availableBalance: true,
          reservedBalance: true,
        },
      }),
      this.prisma.partner.count(),
      this.prisma.partner.count({ where: { status: PartnerStatus.ACTIVE } }),
      this.prisma.distributor.count(),
      this.prisma.distributor.count({ where: { status: 'ACTIVE' } }),
      this.prisma.bookingRequest.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.bookingRequest.findMany({
        take: 8,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          bookingCode: true,
          status: true,
          requestedDate: true,
          requestedDateStr: true,
          pilgrimCount: true,
          timeSlot: true,
          totalTicketAmount: true,
          createdAt: true,
          user: {
            select: {
              name: true,
              mobile: true,
              centre: {
                select: {
                  centreName: true,
                  centreCode: true,
                  district: true,
                },
              },
            },
          },
          pilgrims: {
            take: 1,
            select: {
              fullName: true,
            },
          },
        },
      }),
      this.prisma.centre.findMany({
        take: 6,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          centreName: true,
          centreCode: true,
          district: true,
          taluk: true,
          status: true,
          createdAt: true,
          user: {
            select: {
              name: true,
              mobile: true,
            },
          },
        },
      }),
      this.prisma.workerMachine.findMany({
        take: 8,
        orderBy: [{ status: 'asc' }, { lastHeartbeat: 'desc' }],
        select: {
          id: true,
          machineCode: true,
          machineName: true,
          status: true,
          active: true,
          currentJobId: true,
          lastHeartbeat: true,
          version: true,
          ipAddress: true,
          jobsCompleted: true,
          successCount: true,
        },
      }),
    ]);

    const statusCounts: Record<string, number> = {
      TOTAL: 0,
      QUEUED: 0,
      ASSIGNED: 0,
      WATCHING: 0,
      AVAILABILITY_FOUND: 0,
      BOOKING: 0,
      SUCCESS: 0,
      FAILED: 0,
      UNKNOWN: 0,
      REQUIRES_HUMAN: 0,
      CANCELLED: 0,
    };

    for (const item of bookingsByStatus) {
      statusCounts[item.status] = item._count.id;
      statusCounts.TOTAL += item._count.id;
    }

    const successCount =
      (statusCounts.SUCCESS || 0) +
      (statusCounts.WISHLIST_ADDED || 0) +
      (statusCounts.COMPLETED || 0) +
      (statusCounts.BOOKING_CONFIRMED || 0);

    const totalResolved =
      (statusCounts.SUCCESS || 0) + (statusCounts.FAILED || 0) + (statusCounts.CANCELLED || 0);
    const successRate =
      totalResolved > 0
        ? Number(((successCount / totalResolved) * 100).toFixed(1))
        : successCount > 0
        ? 100
        : 0;

    return {
      hierarchy: {
        partners: {
          total: totalPartners,
          active: activePartners,
          inactive: Math.max(0, totalPartners - activePartners),
        },
        distributors: {
          total: totalDistributors,
          active: activeDistributors,
          inactive: Math.max(0, totalDistributors - activeDistributors),
        },
        centres: {
          total: totalCentres,
          active: activeCentres,
          expired: expiredCentres,
          inactive: Math.max(0, totalCentres - activeCentres),
          activeRate:
            totalCentres > 0 ? Number(((activeCentres / totalCentres) * 100).toFixed(1)) : 0,
        },
      },
      centres: {
        total: totalCentres,
        active: activeCentres,
        expired: expiredCentres,
        inactive: Math.max(0, totalCentres - activeCentres),
        penetrationPercent:
          totalCentres > 0 ? Number(((activeCentres / totalCentres) * 100).toFixed(1)) : 0,
      },
      workers: {
        total: totalWorkers,
        online: onlineWorkers,
        busy: busyWorkers,
        offline: Math.max(0, totalWorkers - onlineWorkers - busyWorkers),
        units: workerList,
      },
      bookings: {
        ...statusCounts,
        today: todayBookingsCount,
        successCount,
        successRate,
      },
      recentBookings: recentBookings.map((b) => ({
        id: b.id,
        bookingCode: b.bookingCode,
        status: b.status,
        requestedDate: b.requestedDate,
        requestedDateStr: b.requestedDateStr,
        pilgrimCount: b.pilgrimCount,
        timeSlot: b.timeSlot,
        totalTicketAmount: Number(b.totalTicketAmount || 0),
        createdAt: b.createdAt,
        centreName: b.user?.centre?.centreName || 'Direct Station',
        centreCode: b.user?.centre?.centreCode || '—',
        district: b.user?.centre?.district || '—',
        customerName: b.pilgrims?.[0]?.fullName || b.user?.name || 'Devotee',
      })),
      recentCentres: recentCentres.map((c) => ({
        id: c.id,
        centreName: c.centreName,
        centreCode: c.centreCode,
        district: c.district,
        taluk: c.taluk,
        status: c.status,
        createdAt: c.createdAt,
        operatorName: c.user?.name || '—',
        mobile: c.user?.mobile || '—',
      })),
      financials: {
        ...financials,
        totalNetworkAvailableBalance: Number(walletsSum._sum.availableBalance || 0),
        totalNetworkReservedBalance: Number(walletsSum._sum.reservedBalance || 0),
      },
      systemConfig,
    };
  }

  async getSystemConfig() {
    try {
      const rows: any[] = await this.prisma.$queryRawUnsafe(
        `SELECT * FROM "SystemConfig" WHERE id = 'default' LIMIT 1`,
      );
      if (rows && rows.length > 0) {
        return rows[0];
      }
    } catch (err: any) {
      this.logger.warn(`Failed raw query for system config: ${err.message}`);
    }

    let config = await this.prisma.systemConfig.findUnique({
      where: { id: 'default' },
    });

    if (!config) {
      config = await (this.prisma.systemConfig as any).create({
        data: {
          id: 'default',
          serviceFee: 100,
          yuktronShare: 100,
          workerShare: 0,
          registrationFee: 249,
          franchiseFee: 599,
          distributorFee: 399,
          accountValidityDays: 365,
          checkingIntervalSeconds: 300,
          leaseTimeoutSeconds: 120,
          humanAssistedModeOnly: false,
          partnerMinWithdrawal: 100,
        },
      });
    }

    return config;
  }

  async getPublicPaymentConfig() {
    const config: any = (await this.getSystemConfig()) || {};
    const upiId = config.offlineUpiId || 'pay.sevatn@okaxis';
    const accountName = config.offlineAccountName || 'SevaTN Services & Network';
    const defaultQr = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=10&data=${encodeURIComponent(
      `upi://pay?pa=${upiId}&pn=${encodeURIComponent(accountName)}&cu=INR`,
    )}`;

    return {
      onlinePaymentEnabled: config.onlinePaymentEnabled === undefined || config.onlinePaymentEnabled === null ? true : Boolean(config.onlinePaymentEnabled && config.onlinePaymentEnabled !== 'false'),
      onlineGatewayProvider: config.onlineGatewayProvider || 'RAZORPAY',
      onlineGatewayKeyId: config.onlineGatewayKeyId || null,
      offlinePaymentEnabled: config.offlinePaymentEnabled === undefined || config.offlinePaymentEnabled === null ? true : Boolean(config.offlinePaymentEnabled && config.offlinePaymentEnabled !== 'false'),
      offlineUpiId: upiId,
      offlineAccountName: accountName,
      offlineQrImageUrl: config.offlineQrImageUrl || defaultQr,
      offlineQrCodeUrl: config.offlineQrImageUrl || defaultQr,
      offlineBankName: config.offlineBankName || 'HDFC Bank',
      offlineAccountNumber: config.offlineAccountNumber || '50200012345678',
      offlineIfscCode: config.offlineIfscCode || 'HDFC0001234',
      offlinePaymentInstructions: config.offlinePaymentInstructions || 'Scan the official QR code or pay via UPI. Enter your 12-digit UTR/Reference ID for instant validation.',
      serviceFee: Number(config.serviceFee || 100),
      registrationFee: Number(config.registrationFee || 249),
      franchiseFee: Number(config.franchiseFee || 599),
      distributorFee: Number((config as any).distributorFee || 399),
      partnerMinWithdrawal: Number((config as any).partnerMinWithdrawal || 100),
      headerMarqueeEnabled: (config as any).headerMarqueeEnabled === undefined || (config as any).headerMarqueeEnabled === null ? false : Boolean((config as any).headerMarqueeEnabled && (config as any).headerMarqueeEnabled !== 'false'),
      headerMarqueeText: (config as any).headerMarqueeText || null,
      headerMarqueeSpeed: Number((config as any).headerMarqueeSpeed || 30),
      headerMarqueeBgColor: (config as any).headerMarqueeBgColor || 'DEFAULT',
    };
  }

  async updateSystemConfig(data: any) {
    const cleanData: any = { ...data };
    delete cleanData.id;
    delete cleanData.updatedAt;

    try {
      // Ensure 'default' row exists
      await this.prisma.$executeRawUnsafe(`
        INSERT INTO "SystemConfig" ("id", "serviceFee", "registrationFee", "franchiseFee", "distributorFee", "accountValidityDays", "checkingIntervalSeconds", "leaseTimeoutSeconds", "humanAssistedModeOnly", "onlinePaymentEnabled", "onlineGatewayProvider", "offlinePaymentEnabled", "offlineUpiId", "offlineAccountName", "partnerMinWithdrawal", "telegramBotEnabled", "telegramBotToken", "telegramChatId", "headerMarqueeEnabled", "headerMarqueeText", "headerMarqueeSpeed", "headerMarqueeBgColor", "updatedAt")
        VALUES ('default', 100, 249, 599, 399, 365, 300, 120, false, true, 'RAZORPAY', true, 'pay.sevatn@okaxis', 'SevaTN Services & Network', 100, false, null, null, false, null, 30, 'DEFAULT', NOW())
        ON CONFLICT ("id") DO NOTHING
      `);

      // Build dynamic SQL update fields
      const updates: string[] = [];
      const values: any[] = [];
      let idx = 1;

      const columnMap: Record<string, string> = {
        serviceFee: 'numeric',
        registrationFee: 'numeric',
        franchiseFee: 'numeric',
        distributorFee: 'numeric',
        partnerMinWithdrawal: 'numeric',
        yuktronShare: 'numeric',
        workerShare: 'numeric',
        accountValidityDays: 'integer',
        checkingIntervalSeconds: 'integer',
        leaseTimeoutSeconds: 'integer',
        humanAssistedModeOnly: 'boolean',
        onlinePaymentEnabled: 'boolean',
        onlineGatewayProvider: 'text',
        onlineGatewayKeyId: 'text',
        onlineGatewayKeySecret: 'text',
        offlinePaymentEnabled: 'boolean',
        offlineUpiId: 'text',
        offlineAccountName: 'text',
        offlineQrImageUrl: 'text',
        offlineBankName: 'text',
        offlineAccountNumber: 'text',
        offlineIfscCode: 'text',
        offlinePaymentInstructions: 'text',
        telegramBotEnabled: 'boolean',
        telegramBotToken: 'text',
        telegramChatId: 'text',
        headerMarqueeEnabled: 'boolean',
        headerMarqueeText: 'text',
        headerMarqueeSpeed: 'integer',
        headerMarqueeBgColor: 'text',
      };

      for (const [key, type] of Object.entries(columnMap)) {
        if (cleanData[key] !== undefined) {
          let val = cleanData[key];
          if (type === 'numeric') {
            val = Number(val);
          } else if (type === 'integer') {
            val = parseInt(val, 10);
          } else if (type === 'boolean') {
            val = Boolean(val);
          } else if (type === 'text') {
            val = val !== null && val !== undefined ? String(val) : null;
          }
          updates.push(`"${key}" = $${idx}`);
          values.push(val);
          idx++;
        }
      }

      updates.push(`"updatedAt" = NOW()`);

      if (updates.length > 0) {
        const sql = `UPDATE "SystemConfig" SET ${updates.join(', ')} WHERE "id" = 'default'`;
        await this.prisma.$executeRawUnsafe(sql, ...values);
      }

      return this.getSystemConfig();
    } catch (err: any) {
      this.logger.error(`Error updating system config: ${err.message}`, err.stack);
      throw err;
    }
  }

  /**
   * Test Telegram Payment Notifier Bot
   */
  async testTelegramNotification(botToken?: string, chatId?: string) {
    return this.notifications.testTelegramNotification(botToken, chatId);
  }

  /**
   * Admin direct action to clear and cancel all pending queues, jobs, and reset workers
   */
  async clearAllQueues(adminUser: any) {
    const activeStatuses: BookingStatus[] = [
      BookingStatus.PENDING,
      BookingStatus.QUEUED,
      BookingStatus.MATCHING,
      BookingStatus.CLAIMED,
      BookingStatus.EXECUTION_QUEUED,
      BookingStatus.EXECUTING,
      BookingStatus.WAITING_FOR_ACCOUNT,
      BookingStatus.WORKER_ASSIGNED,
      BookingStatus.ASSIGNED,
      BookingStatus.BROWSER_STARTING,
      BookingStatus.OFFICIAL_SITE_OPEN,
      BookingStatus.OPENING_OFFICIAL_SITE,
      BookingStatus.LOGIN_IN_PROGRESS,
      BookingStatus.LOGIN_SUCCESS,
      BookingStatus.BOOKING_FLOW_STARTED,
      BookingStatus.OPENING_VIRTUAL_Q,
      BookingStatus.WAITING_FOR_DATE_AVAILABILITY,
      BookingStatus.DATE_AVAILABLE,
      BookingStatus.SELECTING_DATE,
      BookingStatus.VERIFYING_DATE_SELECTION,
      BookingStatus.DATE_SELECTION_VERIFIED,
      BookingStatus.SELECTING_ROUTE,
      BookingStatus.OPENING_PILGRIM_SELECTION,
      BookingStatus.SELECTING_EXISTING_PILGRIMS,
      BookingStatus.SUBMITTING_PILGRIMS,
      BookingStatus.SELECTING_RELIEF_FUND_NO,
      BookingStatus.ADDING_TO_WISHLIST,
      BookingStatus.VERIFYING_RESULT,
      BookingStatus.CHECKING_AVAILABILITY,
      BookingStatus.WATCHING,
      BookingStatus.WAITING,
      BookingStatus.AVAILABILITY_FOUND,
      BookingStatus.BOOKING_IN_PROGRESS,
      BookingStatus.BOOKING,
      BookingStatus.CONFIRMATION_CHECK,
      BookingStatus.REQUIRES_HUMAN,
      BookingStatus.WORKER_ERROR,
      BookingStatus.SITE_ERROR,
      BookingStatus.TIMEOUT,
      BookingStatus.HOLD_INVALID_NOMINEE,
      BookingStatus.RETRYABLE_FAILURE,
    ];

    const terminalStatuses: BookingStatus[] = [
      BookingStatus.SUCCESS,
      BookingStatus.CANCELLED,
      BookingStatus.FAILED,
      BookingStatus.COMPLETED,
      'BOOKING_CONFIRMED' as any,
    ];

    const pendingRequests = await this.prisma.bookingRequest.findMany({
      where: { status: { notIn: terminalStatuses } },
    });

    let releasedHoldsCount = 0;
    for (const booking of pendingRequests) {
      // Release wallet holds
      await this.walletService.release({
        userId: booking.userId,
        bookingId: booking.id,
        amount: 100,
        reason: 'Cleared by Admin from Queue Manager',
        idempotencyKey: `admin_clear_${booking.id}_v${booking.version}_${Date.now()}`,
      });
      releasedHoldsCount++;

      // Cancel booking request and close its jobs atomically in the SAME transaction (shared path with cancelBooking)
      const cancelNow = new Date();
      const cancelFailureReason = `Queue cleared by Admin (${adminUser?.name || 'Administrator'})`;
      const runCancelTx = async (tx: any) => {
        if (this.stateMachine) {
          try {
            await this.stateMachine.transition({
              bookingId: booking.id,
              targetStatus: BookingStatus.CANCELLED,
              targetExecutionStatus: 'IDLE',
              failureReason: cancelFailureReason,
              milestone: 'CANCELLED_BY_ADMIN',
              force: true,
            }, tx);
          } catch (smErr: any) {
            this.logger.warn(`Admin clearQueue fallback for #${booking.id}: ${smErr.message}`);
            await tx.bookingRequest.update({
              where: { id: booking.id },
              data: {
                status: BookingStatus.CANCELLED,
                assignedMachineId: null,
                leaseExpiresAt: null,
                leaseStartedAt: null,
                failureReason: cancelFailureReason,
              },
            });
          }
        } else {
          await tx.bookingRequest.update({
            where: { id: booking.id },
            data: {
              status: BookingStatus.CANCELLED,
              assignedMachineId: null,
              leaseExpiresAt: null,
              leaseStartedAt: null,
              failureReason: cancelFailureReason,
            },
          });
        }

        await tx.bookingJob.updateMany({
          where: {
            bookingRequestId: booking.id,
            status: {
              notIn: [BookingStatus.SUCCESS, BookingStatus.CANCELLED, BookingStatus.FAILED, BookingStatus.COMPLETED],
            },
          },
          data: {
            status: BookingStatus.CANCELLED,
            workerId: null,
            leaseExpiresAt: null,
            completedAt: cancelNow,
          },
        });
      };

      if (typeof this.prisma.$transaction === 'function') {
        await this.prisma.$transaction(runCancelTx);
      } else {
        await runCancelTx(this.prisma);
      }
    }

    // Also cancel any remaining orphaned/unlinked non-terminal jobs
    const cancelledJobs = await this.prisma.bookingJob.updateMany({
      where: {
        status: {
          notIn: [BookingStatus.SUCCESS, BookingStatus.CANCELLED, BookingStatus.FAILED, BookingStatus.COMPLETED],
        },
      },
      data: {
        status: BookingStatus.CANCELLED,
        workerId: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
      },
    });

    // Clear locks & opportunities
    const clearedLocks = await this.prisma.accountLock.deleteMany({});
    const clearedOpps = await this.prisma.availabilityOpportunity.deleteMany({
      where: { status: 'AVAILABLE' },
    });

    // Reset worker machines (including currentActiveJobs counter!)
    const workers = await this.prisma.workerMachine.findMany();
    const now = Date.now();
    for (const worker of workers) {
      const isOnline = worker.active && worker.lastHeartbeat && (now - new Date(worker.lastHeartbeat).getTime() < 60000);
      await this.prisma.workerMachine.update({
        where: { id: worker.id },
        data: {
          currentJobId: null,
          currentBookingId: null,
          currentActiveJobs: 0,
          currentActivity: 'IDLE',
          status: isOnline ? WorkerStatus.ONLINE : WorkerStatus.OFFLINE,
        },
      });
    }

    return {
      message: 'All pending queues, jobs, holds, and locks cleared successfully.',
      clearedBookings: pendingRequests.length,
      releasedHolds: releasedHoldsCount,
      cancelledJobs: cancelledJobs.count,
      clearedLocks: clearedLocks.count,
      clearedOpportunities: clearedOpps.count,
      resetWorkers: workers.length,
    };
  }

  async purgeAllBookings(adminUser: any) {
    this.logger.warn(`[PURGE] Admin ${adminUser?.email || adminUser?.id || 'SUPER_ADMIN'} initiated complete database booking purge.`);

    // 1. Release held wallet funds for any active/pending bookings
    const activeRequests = await this.prisma.bookingRequest.findMany({
      where: {
        status: {
          notIn: [BookingStatus.SUCCESS, BookingStatus.CANCELLED, BookingStatus.FAILED, BookingStatus.COMPLETED],
        },
      },
      select: { id: true, userId: true },
    });

    let releasedHoldsCount = 0;
    for (const b of activeRequests) {
      try {
        const wallet = await this.prisma.wallet.findUnique({ where: { userId: b.userId } });
        if (wallet && Number(wallet.reservedBalance) > 0) {
          const holdToRelease = Math.min(Number(wallet.reservedBalance), 100);
          await this.prisma.wallet.update({
            where: { id: wallet.id },
            data: {
              availableBalance: { increment: holdToRelease },
              reservedBalance: { decrement: holdToRelease },
            },
          });
          releasedHoldsCount++;
        }
      } catch (err: any) {
        this.logger.warn(`Could not release wallet hold for booking ${b.id}: ${err.message}`);
      }
    }

    // 2. Reset all worker machines
    const workers = await this.prisma.workerMachine.findMany();
    const now = Date.now();
    for (const worker of workers) {
      const isOnline = worker.active && worker.lastHeartbeat && (now - new Date(worker.lastHeartbeat).getTime() < 60000);
      await this.prisma.workerMachine.update({
        where: { id: worker.id },
        data: {
          currentBookingId: null,
          currentJobId: null,
          currentActiveJobs: 0,
          currentActivity: 'IDLE',
          activityDetails: 'Idle',
          status: isOnline ? WorkerStatus.ONLINE : WorkerStatus.IDLE,
        },
      });
    }

    // 3. Delete locks & logs
    const clearedLocks = await this.prisma.accountLock.deleteMany({});
    await this.prisma.jobAllocationLog.deleteMany({});
    await this.prisma.workerActivityLog.deleteMany({});

    // 4. Reset opportunities
    await this.prisma.availabilityOpportunity.updateMany({
      data: { matchedBookingId: null },
    });

    // 5. Delete dependent booking records
    await this.prisma.bookingReconciliation.deleteMany({});
    await this.prisma.bookingMilestone.deleteMany({});
    await this.prisma.bookingAttempt.deleteMany({});
    const deletedJobs = await this.prisma.bookingJob.deleteMany({});
    const deletedPilgrims = await this.prisma.bookingPilgrim.deleteMany({});

    // 6. Unlink wallet transactions and ledger entries
    await this.prisma.walletTransaction.updateMany({
      where: { bookingId: { not: null } },
      data: { bookingId: null },
    });
    await this.prisma.walletLedgerEntry.updateMany({
      where: { bookingId: { not: null } },
      data: { bookingId: null },
    });

    // 7. Delete all BookingRequests
    const deletedBookings = await this.prisma.bookingRequest.deleteMany({});

    this.logger.log(`[PURGE] Purged ${deletedBookings.count} bookings, ${deletedJobs.count} jobs, ${deletedPilgrims.count} pilgrims.`);

    return {
      message: 'All bookings and associated jobs have been permanently purged from the database.',
      deletedBookings: deletedBookings.count,
      deletedJobs: deletedJobs.count,
      deletedPilgrims: deletedPilgrims.count,
      releasedHolds: releasedHoldsCount,
      resetWorkers: workers.length,
      clearedLocks: clearedLocks.count,
    };
  }

  async getAdminBookings(query: { status?: BookingStatus; page?: number; limit?: number; search?: string }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 50;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.status && (query.status as any) !== 'ALL') {
      where.status = query.status;
    }
    if (query.search) {
      where.OR = [
        { bookingCode: { contains: query.search, mode: 'insensitive' } },
        { route: { contains: query.search, mode: 'insensitive' } },
        { officialReference: { contains: query.search, mode: 'insensitive' } },
        { user: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [bookings, total] = await Promise.all([
      this.prisma.bookingRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          pilgrims: true,
          account: { select: { id: true, label: true, username: true, status: true } as any },
          assignedMachine: { select: { machineCode: true, machineName: true, status: true } },
          user: {
            select: {
              name: true,
              email: true,
              mobile: true,
              partnerId: true,
              centre: { select: { centreName: true, district: true } },
            },
          },
        },
      }),
      this.prisma.bookingRequest.count({ where }),
    ]);

    return { bookings, total, page, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Comprehensive Financial Ledger Overview & Collection Metrics
   */
  async getLedgerOverview() {
    const [
      txGroups,
      txTotalCount,
      walletsSum,
      walletsCount,
      centresPaid,
      centresPending,
      partnersPaid,
      partnersPending,
      approvedPartnersRecent,
      approvedCentresRecent,
      distributorsPaid,
      distributorsPending,
      approvedDistributorsRecent,
      payoutsRequested,
      payoutsSettled,
      refundsRequested,
      refundsProcessed,
      recentWaitingTopups,
    ] = await Promise.all([
      this.prisma.walletTransaction.groupBy({
        by: ['type', 'status'],
        _sum: {
          amount: true,
          yuktronShare: true,
          workerShare: true,
        },
        _count: { id: true },
      }),
      this.prisma.walletTransaction.count(),
      this.prisma.wallet.aggregate({
        _sum: {
          availableBalance: true,
          reservedBalance: true,
        },
      }),
      this.prisma.wallet.count(),
      this.prisma.centre.aggregate({
        where: { feePaid: true },
        _sum: { registrationFee: true },
        _count: { id: true },
      }),
      this.prisma.centre.findMany({
        where: {
          feePaid: false,
          OR: [
            { feeTransactionId: { not: null } },
            { paymentProofUrl: { not: null } },
            { status: CentreStatus.PENDING_VERIFICATION },
          ],
        },
        include: { user: { select: { id: true, name: true, mobile: true, email: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.partner.aggregate({
        where: { feePaid: true },
        _sum: { franchiseFee: true },
        _count: { id: true },
      }),
      this.prisma.partner.findMany({
        where: {
          feePaid: false,
          OR: [
            { paymentReference: { not: null } },
            { paymentProofUrl: { not: null } },
            { status: PartnerStatus.PENDING_APPROVAL },
          ],
        },
        include: {
          user: {
            select: { id: true, name: true, mobile: true, email: true, status: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.partner.findMany({
        where: { feePaid: true },
        take: 10,
        orderBy: { updatedAt: 'desc' },
        include: { user: { select: { id: true, name: true, mobile: true, email: true } } },
      }),
      this.prisma.centre.findMany({
        where: { feePaid: true },
        take: 10,
        orderBy: { updatedAt: 'desc' },
        include: { user: { select: { id: true, name: true, mobile: true, email: true } } },
      }),
      (this.prisma.distributor as any).aggregate({
        where: { feePaid: true },
        _sum: { distributorFee: true },
        _count: { id: true },
      }),
      (this.prisma.distributor as any).findMany({
        where: {
          feePaid: false,
          OR: [
            { paymentReference: { not: null } },
            { paymentProofUrl: { not: null } },
            { user: { status: UserStatus.PAYMENT_PENDING } },
          ],
        },
        include: {
          user: {
            select: { id: true, name: true, mobile: true, email: true, status: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      (this.prisma.distributor as any).findMany({
        where: { feePaid: true },
        take: 10,
        orderBy: { updatedAt: 'desc' },
        include: { user: { select: { id: true, name: true, mobile: true, email: true } } },
      }),
      this.prisma.partnerPayout.aggregate({
        where: { status: PayoutStatus.REQUESTED },
        _sum: { amount: true },
        _count: { id: true },
      }),
      this.prisma.partnerPayout.aggregate({
        where: { status: PayoutStatus.SETTLED },
        _sum: { amount: true },
        _count: { id: true },
      }),
      this.prisma.refundRequest.aggregate({
        where: { status: RefundStatus.REQUESTED },
        _sum: { amount: true },
        _count: { id: true },
      }),
      this.prisma.refundRequest.aggregate({
        where: { status: RefundStatus.PROCESSED },
        _sum: { amount: true },
        _count: { id: true },
      }),
      this.prisma.walletTransaction.findMany({
        where: { type: TransactionType.TOPUP, status: TransactionStatus.PENDING },
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              mobile: true,
              email: true,
              centre: { select: { centreName: true, centreCode: true, district: true } },
            },
          },
        },
      }),
    ]);

    let totalTopupsCompleted = 0;
    let totalTopupsPending = 0;
    let topupsCountCompleted = 0;
    let topupsCountPending = 0;

    let totalCaptured = 0;
    let capturedCount = 0;
    let yuktronRevenue = 0;
    let workerSettlement = 0;

    let totalReserved = 0;
    let reservedCount = 0;
    let totalReleased = 0;
    let releasedCount = 0;

    let totalRefunded = 0;
    let refundedCount = 0;

    for (const g of txGroups) {
      const sum = Number(g._sum.amount || 0);
      const count = g._count.id || 0;

      if (g.type === TransactionType.TOPUP) {
        if (g.status === TransactionStatus.COMPLETED) {
          totalTopupsCompleted += sum;
          topupsCountCompleted += count;
        } else if (g.status === TransactionStatus.PENDING) {
          totalTopupsPending += sum;
          topupsCountPending += count;
        }
      } else if (g.type === TransactionType.CAPTURE) {
        if (g.status === TransactionStatus.COMPLETED) {
          totalCaptured += sum;
          capturedCount += count;
          yuktronRevenue += Number(g._sum.yuktronShare || 0);
          workerSettlement += Number(g._sum.workerShare || 0);
        }
      } else if (g.type === TransactionType.RESERVE) {
        if (g.status === TransactionStatus.COMPLETED) {
          totalReserved += sum;
          reservedCount += count;
        }
      } else if (g.type === TransactionType.RELEASE) {
        if (g.status === TransactionStatus.COMPLETED) {
          totalReleased += sum;
          releasedCount += count;
        }
      } else if (g.type === TransactionType.REFUND) {
        if (g.status === TransactionStatus.COMPLETED) {
          totalRefunded += sum;
          refundedCount += count;
        }
      }
    }

    const centreFeesCollected = Number(centresPaid._sum.registrationFee || 0);
    const centreFeesCount = centresPaid._count.id || 0;

    const partnerFeesCollected = Number(partnersPaid._sum.franchiseFee || 0);
    const partnerFeesCount = partnersPaid._count.id || 0;

    const distributorFeesCollected = Number((distributorsPaid as any)?._sum?.distributorFee || 0);
    const distributorFeesCount = (distributorsPaid as any)?._count?.id || (distributorsPaid as any)?._count || 0;

    const grandTotalCollections = totalTopupsCompleted + centreFeesCollected + partnerFeesCollected + distributorFeesCollected;
    const grandPlatformRevenue = yuktronRevenue + centreFeesCollected + partnerFeesCollected + distributorFeesCollected;

    const pendingCentresCount = centresPending.length;
    const pendingCentresFeeSum = centresPending.reduce((acc, c) => acc + Number(c.registrationFee || 249), 0);

    const pendingPartnersCount = partnersPending.length;
    const pendingPartnersFeeSum = partnersPending.reduce((acc, p) => acc + Number(p.franchiseFee || 599), 0);

    const pendingDistributorsCount = distributorsPending.length;
    const pendingDistributorsFeeSum = distributorsPending.reduce((acc, d: any) => acc + Number((d as any)?.distributorFee || 399), 0);

    const pendingPayoutsAmount = Number(payoutsRequested._sum.amount || 0);
    const pendingPayoutsCount = payoutsRequested._count.id || 0;

    const pendingRefundsAmount = Number(refundsRequested._sum.amount || 0);
    const pendingRefundsCount = refundsRequested._count.id || 0;

    const totalWaitingItemsCount = topupsCountPending + pendingCentresCount + pendingPartnersCount + pendingDistributorsCount + pendingPayoutsCount + pendingRefundsCount;
    const totalWaitingAmount = totalTopupsPending + pendingCentresFeeSum + pendingPartnersFeeSum + pendingDistributorsFeeSum + pendingPayoutsAmount + pendingRefundsAmount;

    return {
      summary: {
        grandTotalCollections,
        grandPlatformRevenue,
        workerSettlement,
        totalCaptured,
        capturedCount,
        totalWaitingItemsCount,
        totalWaitingAmount,
        networkHoldings: {
          totalAvailableBalance: Number(walletsSum._sum.availableBalance || 0),
          totalReservedBalance: Number(walletsSum._sum.reservedBalance || 0),
          walletsCount,
        },
      },
      collectionsBreakdown: {
        walletTopups: {
          completedAmount: totalTopupsCompleted,
          completedCount: topupsCountCompleted,
          pendingAmount: totalTopupsPending,
          pendingCount: topupsCountPending,
        },
        servicePassCaptures: {
          totalAmount: totalCaptured,
          totalCount: capturedCount,
          platformShare: yuktronRevenue,
          workerShare: workerSettlement,
        },
        centreRegistrations: {
          collectedAmount: centreFeesCollected,
          collectedCount: centreFeesCount,
          pendingCount: pendingCentresCount,
          pendingAmount: pendingCentresFeeSum,
        },
        partnerFranchise: {
          collectedAmount: partnerFeesCollected,
          collectedCount: partnerFeesCount,
          pendingCount: pendingPartnersCount,
          pendingAmount: pendingPartnersFeeSum,
        },
        distributorLicense: {
          collectedAmount: distributorFeesCollected,
          collectedCount: distributorFeesCount,
          pendingCount: pendingDistributorsCount,
          pendingAmount: pendingDistributorsFeeSum,
        },
      },
      escrowLifecycle: {
        totalTopupsCompleted,
        totalReserved,
        totalCaptured,
        totalReleased,
        totalRefunded,
        activeReservedInQueue: Number(walletsSum._sum.reservedBalance || 0),
        activeAvailableInWallets: Number(walletsSum._sum.availableBalance || 0),
      },
      waitingActionItems: {
        pendingTopupsCount: topupsCountPending,
        pendingTopupsAmount: totalTopupsPending,
        pendingCentresCount,
        pendingCentresAmount: pendingCentresFeeSum,
        pendingPartnersCount,
        pendingPartnersAmount: pendingPartnersFeeSum,
        pendingDistributorsCount,
        pendingDistributorsAmount: pendingDistributorsFeeSum,
        pendingPayoutsCount,
        pendingPayoutsAmount,
        pendingRefundsCount,
        pendingRefundsAmount,
        recentWaitingTopups,
        pendingDistributors: distributorsPending.map((d: any) => ({
          id: d.id,
          distributorName: d.businessName || d.name,
          applicantName: d.name,
          distributorCode: d.distributorCode,
          district: d.district,
          taluk: d.taluk,
          distributorFee: Number(d.distributorFee || 399),
          paymentReference: d.paymentReference,
          paymentProofUrl: d.paymentProofUrl,
          status: d.status,
          user: d.user,
          createdAt: d.createdAt,
        })),
        approvedDistributorsRecent: approvedDistributorsRecent.map((d: any) => ({
          id: d.id,
          distributorName: d.businessName || d.name,
          applicantName: d.name,
          distributorCode: d.distributorCode,
          district: d.district,
          taluk: d.taluk,
          distributorFee: Number(d.distributorFee || 399),
          paymentReference: d.paymentReference,
          paymentProofUrl: d.paymentProofUrl,
          status: d.status,
          user: d.user,
          updatedAt: d.updatedAt,
        })),
        pendingCentres: centresPending.map((c) => ({
          id: c.id,
          centreName: c.centreName,
          centreCode: c.centreCode,
          district: c.district,
          taluk: c.taluk,
          registrationFee: Number(c.registrationFee),
          feeTransactionId: c.feeTransactionId,
          paymentProofUrl: c.paymentProofUrl,
          user: c.user,
          createdAt: c.createdAt,
        })),
        pendingPartners: partnersPending.map((p) => ({
          id: p.id,
          partnerName: p.name,
          partnerCode: p.partnerCode,
          district: p.district,
          taluk: p.taluk,
          franchiseFee: Number(p.franchiseFee || 599),
          paymentReference: p.paymentReference,
          paymentProofUrl: p.paymentProofUrl,
          status: p.status,
          user: p.user,
          createdAt: p.createdAt,
        })),
        approvedPartnersRecent: approvedPartnersRecent.map((p) => ({
          id: p.id,
          partnerName: p.name,
          partnerCode: p.partnerCode,
          district: p.district,
          taluk: p.taluk,
          franchiseFee: Number(p.franchiseFee || 599),
          paymentReference: p.paymentReference,
          paymentProofUrl: p.paymentProofUrl,
          status: p.status,
          user: p.user,
          updatedAt: p.updatedAt,
        })),
        approvedCentresRecent: approvedCentresRecent.map((c) => ({
          id: c.id,
          centreName: c.centreName,
          centreCode: c.centreCode,
          district: c.district,
          taluk: c.taluk,
          registrationFee: Number(c.registrationFee),
          feeTransactionId: c.feeTransactionId,
          paymentProofUrl: c.paymentProofUrl,
          user: c.user,
          updatedAt: c.updatedAt,
        })),
      },
    };
  }

  /**
   * Filterable, Searchable & Paginated Ledger Transactions
   */
  async getLedgerTransactions(query: {
    page?: number;
    limit?: number;
    status?: string;
    type?: string;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));

    const where: Prisma.WalletTransactionWhereInput = {};

    if (query.status && query.status !== 'ALL') {
      where.status = query.status as TransactionStatus;
    }

    if (query.type && query.type !== 'ALL') {
      where.type = query.type as TransactionType;
    }

    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) where.createdAt.gte = new Date(query.dateFrom);
      if (query.dateTo) {
        const end = new Date(query.dateTo);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }

    if (query.search && query.search.trim()) {
      const s = query.search.trim();
      where.OR = [
        { reference: { contains: s, mode: 'insensitive' } },
        { id: { contains: s, mode: 'insensitive' } },
        { user: { name: { contains: s, mode: 'insensitive' } } },
        { user: { mobile: { contains: s, mode: 'insensitive' } } },
        { user: { email: { contains: s, mode: 'insensitive' } } },
        { user: { centre: { centreName: { contains: s, mode: 'insensitive' } } } },
        { user: { centre: { centreCode: { contains: s, mode: 'insensitive' } } } },
      ];
    }

    const countBaseWhere = { ...where };
    delete countBaseWhere.status;

    const [
      transactions,
      total,
      allCount,
      pendingCount,
      completedCount,
      failedCount,
    ] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              mobile: true,
              email: true,
              centre: {
                select: {
                  id: true,
                  centreName: true,
                  centreCode: true,
                  district: true,
                  taluk: true,
                },
              },
            },
          },
          booking: {
            select: {
              id: true,
              bookingCode: true,
              route: true,
              requestedDateStr: true,
              status: true,
            },
          },
        },
      }),
      this.prisma.walletTransaction.count({ where }),
      this.prisma.walletTransaction.count({ where: countBaseWhere }),
      this.prisma.walletTransaction.count({
        where: { ...countBaseWhere, status: TransactionStatus.PENDING },
      }),
      this.prisma.walletTransaction.count({
        where: { ...countBaseWhere, status: TransactionStatus.COMPLETED },
      }),
      this.prisma.walletTransaction.count({
        where: { ...countBaseWhere, status: TransactionStatus.FAILED },
      }),
    ]);

    return {
      transactions,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      counts: {
        all: allCount,
        pending: pendingCount,
        completed: completedCount,
        failed: failedCount,
      },
    };
  }

  /**
   * Admin verifies pending top-up and credits wallet
   */
  async verifyTopupTransaction(adminUser: any, transactionId: string) {
    return this.walletService.verifyTopup(adminUser.id, transactionId);
  }

  /**
   * Admin rejects pending top-up
   */
  async rejectTopupTransaction(adminUser: any, transactionId: string, reason?: string) {
    return this.walletService.rejectTopup(adminUser.id, transactionId, reason);
  }

  /**
   * Admin verifies centre registration fee and activates centre
   */
  async verifyCentreRegistrationFee(adminUser: any, centreId: string) {
    const centre = await this.prisma.centre.findUnique({
      where: { id: centreId },
      include: { user: true },
    });
    if (!centre) {
      throw new NotFoundException(`Centre '${centreId}' not found`);
    }

    const now = new Date();
    const expiry = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: centre.userId },
        data: {
          status: UserStatus.ACTIVE,
          registrationDate: now,
          expiryDate: expiry,
        },
      });

      return tx.centre.update({
        where: { id: centreId },
        data: {
          status: CentreStatus.ACTIVE,
          feePaid: true,
        },
        include: { user: true },
      });
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminUser.id,
        actorType: 'ADMIN',
        action: 'CENTRE_REGISTRATION_FEE_VERIFIED',
        entity: 'Centre',
        entityId: centreId,
        metadata: {
          verifiedBy: adminUser.email,
          registrationFee: Number(centre.registrationFee),
          feeTransactionId: centre.feeTransactionId,
        },
      },
    });

    return {
      message: 'Centre registration payment verified and centre activated successfully.',
      centre: updated,
    };
  }

  /**
   * Admin rejects centre registration payment
   */
  async rejectCentreRegistrationFee(adminUser: any, centreId: string, reason?: string) {
    const centre = await this.prisma.centre.findUnique({
      where: { id: centreId },
      include: { user: true },
    });
    if (!centre) {
      throw new NotFoundException(`Centre '${centreId}' not found`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: centre.userId },
        data: {
          status: UserStatus.SUSPENDED,
        },
      });

      return tx.centre.update({
        where: { id: centreId },
        data: {
          status: CentreStatus.SUSPENDED,
          feePaid: false,
        },
        include: { user: true },
      });
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminUser?.id,
        actorType: 'ADMIN',
        action: 'CENTRE_REGISTRATION_FEE_REJECTED',
        entity: 'Centre',
        entityId: centreId,
        metadata: {
          rejectedBy: adminUser?.email,
          registrationFee: Number(centre.registrationFee),
          feeTransactionId: centre.feeTransactionId,
          reason,
        },
      },
    });

    return {
      message: `Centre '${centre.centreName}' registration fee rejected.`,
      centre: updated,
    };
  }

  /**
   * Admin verifies partner franchise fee and activates partner
   */
  async verifyPartnerFranchiseFee(adminUser: any, partnerId: string, notes?: string) {
    const partner = await this.prisma.partner.findUnique({
      where: { id: partnerId },
      include: { user: true },
    });
    if (!partner) {
      throw new NotFoundException(`Partner '${partnerId}' not found`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const p = await tx.partner.update({
        where: { id: partnerId },
        data: {
          status: PartnerStatus.ACTIVE,
          feePaid: true,
        },
      });

      if (partner.userId) {
        await tx.user.update({
          where: { id: partner.userId },
          data: {
            status: UserStatus.ACTIVE,
            registrationDate: new Date(),
          },
        });
      }

      await tx.partnerInvitation.updateMany({
        where: { partnerId, status: InvitationStatus.ACTIVE },
        data: {
          status: InvitationStatus.USED,
          usedAt: new Date(),
        },
      });

      return p;
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminUser?.id,
        actorType: 'ADMIN',
        action: 'PARTNER_FRANCHISE_FEE_VERIFIED',
        entity: 'Partner',
        entityId: partnerId,
        metadata: {
          verifiedBy: adminUser?.email,
          partnerCode: partner.partnerCode,
          franchiseFee: Number(partner.franchiseFee || 599),
          adminNotes: notes,
        },
      },
    });

    return {
      message: `Partner ${updated.name} (${updated.partnerCode}) franchise payment verified and partner activated successfully.`,
      partner: updated,
    };
  }

  /**
   * Admin verifies distributor registration fee and activates distributor
   */
  async verifyDistributorRegistrationFee(adminUser: any, distributorId: string) {
    const distributor = await this.prisma.distributor.findUnique({
      where: { id: distributorId },
      include: { user: true },
    });
    if (!distributor) {
      throw new NotFoundException(`Distributor '${distributorId}' not found`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const d = await (tx as any).distributor.update({
        where: { id: distributorId },
        data: {
          status: 'ACTIVE',
          feePaid: true,
        },
      });

      if (distributor.userId) {
        await tx.user.update({
          where: { id: distributor.userId },
          data: {
            status: UserStatus.ACTIVE,
            registrationDate: new Date(),
          },
        });
      }

      return d;
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminUser?.id,
        actorType: 'ADMIN',
        action: 'DISTRIBUTOR_REGISTRATION_FEE_VERIFIED',
        entity: 'Distributor',
        entityId: distributorId,
        metadata: {
          verifiedBy: adminUser?.email,
          distributorName: distributor.name,
          paymentReference: (distributor as any).paymentReference,
        },
      },
    });

    return {
      message: `Distributor '${distributor.name}' registration fee verified and account activated.`,
      distributor: updated,
    };
  }

  /**
   * Admin rejects distributor registration fee
   */
  async rejectDistributorRegistrationFee(adminUser: any, distributorId: string, reason?: string) {
    const distributor = await this.prisma.distributor.findUnique({
      where: { id: distributorId },
      include: { user: true },
    });
    if (!distributor) {
      throw new NotFoundException(`Distributor '${distributorId}' not found`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const d = await (tx as any).distributor.update({
        where: { id: distributorId },
        data: {
          feePaid: false,
          paymentReference: null,
          paymentProofUrl: null,
          status: 'SUSPENDED',
        },
      });

      if (distributor.userId) {
        await tx.user.update({
          where: { id: distributor.userId },
          data: {
            status: UserStatus.PAYMENT_PENDING,
          },
        });
      }

      return d;
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminUser?.id,
        actorType: 'ADMIN',
        action: 'DISTRIBUTOR_REGISTRATION_FEE_REJECTED',
        entity: 'Distributor',
        entityId: distributorId,
        metadata: {
          rejectedBy: adminUser?.email,
          distributorName: distributor.name,
          reason: reason || 'Invalid payment reference or unverified proof',
        },
      },
    });

    return {
      message: `Distributor '${distributor.name}' registration fee was rejected.`,
      distributor: updated,
    };
  }

  /**
   * Admin rejects partner franchise fee and disables partner
   */
  async rejectPartnerFranchiseFee(adminUser: any, partnerId: string, reason?: string) {
    const partner = await this.prisma.partner.findUnique({
      where: { id: partnerId },
      include: { user: true },
    });
    if (!partner) {
      throw new NotFoundException(`Partner '${partnerId}' not found`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const p = await tx.partner.update({
        where: { id: partnerId },
        data: {
          status: PartnerStatus.DISABLED,
          feePaid: false,
        },
      });

      if (partner.userId) {
        await tx.user.update({
          where: { id: partner.userId },
          data: {
            status: UserStatus.SUSPENDED,
          },
        });
      }

      return p;
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminUser?.id,
        actorType: 'ADMIN',
        action: 'PARTNER_FRANCHISE_FEE_REJECTED',
        entity: 'Partner',
        entityId: partnerId,
        metadata: {
          rejectedBy: adminUser?.email,
          partnerCode: partner.partnerCode,
          franchiseFee: Number(partner.franchiseFee || 599),
          reason,
        },
      },
    });

    return {
      message: `Partner ${updated.name} (${updated.partnerCode}) franchise application rejected.`,
      partner: updated,
    };
  }

  /**
   * Dispatches summary of all pending ledger waiting action items to Telegram
   */
  async notifyLedgerPendingTelegram() {
    const overview = await this.getLedgerOverview();
    const result = await this.notifications.sendTelegramLedgerPendingSummary(overview.waitingActionItems);
    return {
      success: result.success !== false,
      waitingActionItems: overview.waitingActionItems,
      result,
    };
  }

  /**
   * Dispatches manual or targeted Telegram notification for a booking in Central Booking Queue
   */
  async notifyBookingTelegram(bookingId: string) {
    const booking = await this.prisma.bookingRequest.findUnique({
      where: { id: bookingId },
      include: {
        user: { include: { centre: true } },
        assignedMachine: true,
      },
    });

    if (!booking) {
      throw new NotFoundException(`Booking #${bookingId} not found`);
    }

    const result = await this.notifications.sendTelegramBookingNotification({
      bookingId: booking.id,
      bookingCode: booking.bookingCode,
      status: booking.status,
      officialReference: (booking as any).officialBookingReference || (booking as any).officialReference,
      failureReason: (booking as any).failureReason,
      requiresHumanNote: (booking as any).requiresHumanNote,
      note: (booking as any).requiresHumanNote || (booking as any).failureReason,
      route: booking.route,
      requestedDate: booking.requestedDate,
      selectedTime: (booking as any).selectedTime || booking.timeSlot,
      pilgrimCount: booking.pilgrimCount,
      centreName: booking.user?.centre?.centreName,
      operatorName: booking.user?.name,
      district: booking.user?.centre?.district,
      mobile: booking.user?.mobile,
      machineCode: booking.assignedMachine?.machineCode,
    });

    return {
      success: result.success !== false,
      bookingCode: booking.bookingCode,
      status: booking.status,
      result,
    };
  }

  /**
   * Surfaces bookings awaiting reconciliation in the admin queue
   */
  async getReconciliationsQueue() {
    return this.prisma.bookingReconciliation.findMany({
      where: {
        status: { in: ['PENDING', 'HUMAN_REVIEW'] },
      },
      include: {
        bookingRequest: {
          include: {
            user: { select: { id: true, name: true, mobile: true, email: true } },
            jobs: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Admin "Complete with reference" action: completes booking with official reference and captures funds
   */
  async completeWithReference(bookingId: string, officialReference: string, adminUser: any) {
    if (!officialReference || officialReference.trim().length < 5) {
      throw new BadRequestException('Valid official booking reference is required');
    }
    const cleanRef = officialReference.trim();

    const booking = await this.prisma.bookingRequest.findUnique({
      where: { id: bookingId },
      include: { jobs: true },
    });
    if (!booking) {
      throw new NotFoundException(`Booking #${bookingId} not found`);
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const job = booking.jobs && booking.jobs.length > 0 ? booking.jobs[0] : null;
      if (job) {
        await tx.bookingJob.update({
          where: { id: job.id },
          data: { status: BookingStatus.SUCCESS, completedAt: now },
        });
      }

      await tx.bookingRequest.update({
        where: { id: bookingId },
        data: {
          status: BookingStatus.SUCCESS,
          executionStatus: 'COMPLETED',
          financialStatus: 'CAPTURED',
          officialReference: cleanRef,
          officialBookingReference: cleanRef,
          completedAt: now,
          assignedMachineId: null,
          leaseExpiresAt: null,
          reconciliationStatus: 'RECONCILED_SUCCESS',
          requiresHumanNote: `Manually completed by Admin ${adminUser?.email || adminUser?.id || 'SUPER_ADMIN'}`,
        },
      });

      const reserveTx = await tx.walletTransaction.findFirst({
        where: { bookingId, type: 'RESERVE', status: 'COMPLETED' },
      });
      const feeAmount = reserveTx ? Number(reserveTx.amount) : 10;
      await this.walletService.capture({
        userId: booking.userId,
        bookingId,
        amount: feeAmount,
        idempotencyKey: `cap_${bookingId}`,
      }, tx);

      await tx.bookingReconciliation.upsert({
        where: { bookingRequestId: bookingId },
        update: {
          status: 'RECONCILED_SUCCESS',
          resolvedReference: cleanRef,
          resolvedByUserId: adminUser?.id || null,
          resolvedAt: now,
          investigationNote: `Completed with reference by ${adminUser?.email || 'Admin'}`,
        },
        create: {
          bookingRequestId: bookingId,
          status: 'RECONCILED_SUCCESS',
          resolvedReference: cleanRef,
          resolvedByUserId: adminUser?.id || null,
          resolvedAt: now,
          investigationNote: `Completed with reference by ${adminUser?.email || 'Admin'}`,
        },
      });
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminUser?.id || 'SUPER_ADMIN',
        actorType: 'ADMIN',
        action: 'COMPLETE_BOOKING_WITH_REFERENCE',
        entity: 'BookingRequest',
        entityId: bookingId,
        metadata: { officialReference: cleanRef },
      },
    });

    return {
      success: true,
      message: `Booking #${booking.bookingCode} completed successfully with reference ${cleanRef}`,
      reference: cleanRef,
    };
  }
}
