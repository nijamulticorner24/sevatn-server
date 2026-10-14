import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
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
  ) {}

  async getDashboardMetrics() {
    const TARGET_BOOKINGS = 5000;
    const TARGET_CENTRES = 356;

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
    const commercialProgressPercent = Number(((successCount / TARGET_BOOKINGS) * 100).toFixed(1));
    const avgBookingsPerActiveCentre =
      activeCentres > 0 ? Number((successCount / activeCentres).toFixed(1)) : 0;

    return {
      centres: {
        total: totalCentres,
        active: activeCentres,
        expired: expiredCentres,
        networkTarget: TARGET_CENTRES,
        penetrationPercent: Number(((totalCentres / TARGET_CENTRES) * 100).toFixed(1)),
      },
      workers: {
        total: totalWorkers,
        online: onlineWorkers,
        busy: busyWorkers,
        offline: Math.max(0, totalWorkers - onlineWorkers - busyWorkers),
      },
      bookings: statusCounts,
      commercialTarget: {
        targetBookings: TARGET_BOOKINGS,
        successfulBookings: successCount,
        progressPercent: commercialProgressPercent,
        avgPerActiveCentre: avgBookingsPerActiveCentre,
        requiredAvgPerCentre: Number((TARGET_BOOKINGS / TARGET_CENTRES).toFixed(1)), // ~14
      },
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
    const upiId = config.offlineUpiId || 'pay.ticketassist@okaxis';
    const accountName = config.offlineAccountName || 'TicketAssist Services & Network';
    const defaultQr = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=10&data=${encodeURIComponent(
      `upi://pay?pa=${upiId}&pn=${encodeURIComponent(accountName)}&cu=INR`,
    )}`;

    return {
      onlinePaymentEnabled: config.onlinePaymentEnabled ?? true,
      onlineGatewayProvider: config.onlineGatewayProvider || 'RAZORPAY',
      onlineGatewayKeyId: config.onlineGatewayKeyId || null,
      offlinePaymentEnabled: config.offlinePaymentEnabled ?? true,
      offlineUpiId: upiId,
      offlineAccountName: accountName,
      offlineQrImageUrl: config.offlineQrImageUrl || defaultQr,
      offlineBankName: config.offlineBankName || 'HDFC Bank',
      offlineAccountNumber: config.offlineAccountNumber || '50200012345678',
      offlineIfscCode: config.offlineIfscCode || 'HDFC0001234',
      offlinePaymentInstructions: config.offlinePaymentInstructions || 'Scan the official QR code or pay via UPI. Enter your 12-digit UTR/Reference ID for instant validation.',
      serviceFee: Number(config.serviceFee || 100),
      registrationFee: Number(config.registrationFee || 249),
      franchiseFee: Number(config.franchiseFee || 599),
      partnerMinWithdrawal: Number(config.partnerMinWithdrawal || 100),
    };
  }

  async updateSystemConfig(data: any) {
    const cleanData: any = { ...data };
    delete cleanData.id;
    delete cleanData.updatedAt;

    try {
      // Ensure 'default' row exists
      await this.prisma.$executeRawUnsafe(`
        INSERT INTO "SystemConfig" ("id", "serviceFee", "registrationFee", "franchiseFee", "accountValidityDays", "checkingIntervalSeconds", "leaseTimeoutSeconds", "humanAssistedModeOnly", "onlinePaymentEnabled", "onlineGatewayProvider", "offlinePaymentEnabled", "offlineUpiId", "offlineAccountName", "partnerMinWithdrawal", "updatedAt")
        VALUES ('default', 100, 249, 599, 365, 300, 120, false, true, 'RAZORPAY', true, 'pay.ticketassist@okaxis', 'TicketAssist Services & Network', 100, NOW())
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
    ];

    const pendingRequests = await this.prisma.bookingRequest.findMany({
      where: { status: { in: activeStatuses } },
    });

    let releasedHoldsCount = 0;
    for (const booking of pendingRequests) {
      // Release wallet holds
      await this.walletService.release({
        userId: booking.userId,
        bookingId: booking.id,
        amount: 100,
        reason: 'Cleared by Admin from Queue Manager',
        idempotencyKey: `admin_clear_${booking.id}`,
      });
      releasedHoldsCount++;

      // Cancel booking request
      await this.prisma.bookingRequest.update({
        where: { id: booking.id },
        data: {
          status: BookingStatus.CANCELLED,
          assignedMachineId: null,
          leaseExpiresAt: null,
          leaseStartedAt: null,
          failureReason: `Queue cleared by Admin (${adminUser?.name || 'Administrator'})`,
        },
      });
    }

    // Cancel all pending/active jobs
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
      },
    });

    // Clear locks & opportunities
    const clearedLocks = await this.prisma.accountLock.deleteMany({});
    const clearedOpps = await this.prisma.availabilityOpportunity.deleteMany({
      where: { status: 'AVAILABLE' },
    });

    // Reset worker machines
    const workers = await this.prisma.workerMachine.findMany();
    const now = Date.now();
    for (const worker of workers) {
      const isOnline = worker.active && worker.lastHeartbeat && (now - new Date(worker.lastHeartbeat).getTime() < 60000);
      await this.prisma.workerMachine.update({
        where: { id: worker.id },
        data: {
          currentJobId: null,
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

    const grandTotalCollections = totalTopupsCompleted + centreFeesCollected + partnerFeesCollected;
    const grandPlatformRevenue = yuktronRevenue + centreFeesCollected + partnerFeesCollected;

    const pendingCentresCount = centresPending.length;
    const pendingCentresFeeSum = centresPending.reduce((acc, c) => acc + Number(c.registrationFee || 249), 0);

    const pendingPartnersCount = partnersPending.length;
    const pendingPartnersFeeSum = partnersPending.reduce((acc, p) => acc + Number(p.franchiseFee || 599), 0);

    const pendingPayoutsAmount = Number(payoutsRequested._sum.amount || 0);
    const pendingPayoutsCount = payoutsRequested._count.id || 0;

    const pendingRefundsAmount = Number(refundsRequested._sum.amount || 0);
    const pendingRefundsCount = refundsRequested._count.id || 0;

    const totalWaitingItemsCount = topupsCountPending + pendingCentresCount + pendingPartnersCount + pendingPayoutsCount + pendingRefundsCount;
    const totalWaitingAmount = totalTopupsPending + pendingCentresFeeSum + pendingPartnersFeeSum + pendingPayoutsAmount + pendingRefundsAmount;

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
        pendingPayoutsCount,
        pendingPayoutsAmount,
        pendingRefundsCount,
        pendingRefundsAmount,
        recentWaitingTopups,
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
}
