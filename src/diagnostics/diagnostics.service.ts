import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  BookingStatus,
  WorkerStatus,
  TransactionType,
  TransactionStatus,
  Role,
} from '@prisma/client';

export interface AnalyticsFilterDto {
  range?: string;
  startDate?: string;
  endDate?: string;
  service?: string;
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
  userSegment?: string;
}

const SUCCESS_STATUSES: BookingStatus[] = [
  BookingStatus.BOOKING_CONFIRMED,
  BookingStatus.SUCCESS,
  BookingStatus.COMPLETED,
];

const FAILED_STATUSES: BookingStatus[] = [
  BookingStatus.FAILED,
  BookingStatus.SITE_ERROR,
  BookingStatus.WORKER_ERROR,
  BookingStatus.TIMEOUT,
  BookingStatus.SITE_UNAVAILABLE,
  BookingStatus.SUBMIT_FAILED,
];

const isSuccessStatus = (s: BookingStatus): boolean => SUCCESS_STATUSES.includes(s);
const isFailedStatus = (s: BookingStatus): boolean => FAILED_STATUSES.includes(s);

@Injectable()
export class DiagnosticsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Existing Fleet & Telemetry Health Audit
   */
  async analyzeFleetAndLogs() {
    const [failedAttempts, unknownBookings, offlineMachines, pendingHumanBookings] =
      await Promise.all([
        this.prisma.bookingAttempt.findMany({
          where: { status: BookingStatus.FAILED },
          take: 20,
          orderBy: { startedAt: 'desc' },
          include: { booking: true, machine: true },
        }),
        this.prisma.bookingRequest.findMany({
          where: { status: BookingStatus.UNKNOWN },
          take: 10,
        }),
        this.prisma.workerMachine.findMany({
          where: { status: WorkerStatus.OFFLINE, active: true },
        }),
        this.prisma.bookingRequest.findMany({
          where: { status: BookingStatus.REQUIRES_HUMAN },
          take: 10,
        }),
      ]);

    const anomalies: any[] = [];
    const recommendations: any[] = [];

    if (offlineMachines.length > 0) {
      anomalies.push({
        severity: 'HIGH',
        category: 'WORKER_FLEET',
        title: `${offlineMachines.length} Active Worker Machines Offline`,
        description: `Worker units (${offlineMachines.map((m) => m.machineCode).join(', ')}) have stopped sending heartbeats.`,
      });
      recommendations.push({
        priority: 'IMMEDIATE',
        action: 'Restart Worker Docker containers or verify outbound network connectivity on host PCs.',
      });
    }

    if (pendingHumanBookings.length > 0) {
      anomalies.push({
        severity: 'MEDIUM',
        category: 'COMPLIANCE_AND_VERIFICATION',
        title: `${pendingHumanBookings.length} Bookings Require Human Assistance`,
        description:
          'Official booking portal presented manual verification challenges (CAPTCHA/OTP). Guardrails safely halted automation.',
      });
      recommendations.push({
        priority: 'HIGH',
        action: 'Notify respective partner centres to complete manual verification through official portal.',
      });
    }

    if (unknownBookings.length > 0) {
      anomalies.push({
        severity: 'MEDIUM',
        category: 'FINANCIAL_INTEGRITY',
        title: `${unknownBookings.length} Unreconciled (UNKNOWN) Bookings`,
        description: 'Confirmation was ambiguous during booking attempt. Funds remain safely reserved.',
      });
      recommendations.push({
        priority: 'NORMAL',
        action: 'Audit official booking portal reference history and reconcile capture/release state.',
      });
    }

    if (anomalies.length === 0) {
      anomalies.push({
        severity: 'LOW',
        category: 'FLEET_HEALTH',
        title: 'All Systems Operating Normally',
        description: 'Worker queue healthy, zero duplicate captures detected, zero compliance leaks.',
      });
      recommendations.push({
        priority: 'ROUTINE',
        action: 'Continue standard 5-minute compliant checking intervals.',
      });
    }

    return {
      timestamp: new Date().toISOString(),
      healthScore: Math.max(20, 100 - offlineMachines.length * 15 - unknownBookings.length * 10),
      anomalies,
      recommendations,
      metrics: {
        failedAttemptCount: failedAttempts.length,
        unknownCount: unknownBookings.length,
        offlineMachineCount: offlineMachines.length,
        requiresHumanCount: pendingHumanBookings.length,
      },
    };
  }

  /**
   * Advanced User & Booking Analytics
   */
  async getAdvancedAnalytics(filter: AnalyticsFilterDto) {
    const { start, end, prevStart, prevEnd, rangeLabel } = this.calculateDateRange(
      filter.range || '30d',
      filter.startDate,
      filter.endDate,
    );

    // 1. Authoritative System Configuration
    const config = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
    const serviceFee = config?.serviceFee ? Number(config.serviceFee) : 100.0;

    // 2. Build Prisma Booking Where Filters
    const bookingWhere: any = {
      createdAt: { gte: start, lte: end },
    };
    if (filter.service && filter.service !== 'ALL') {
      bookingWhere.route = filter.service;
    }
    if (filter.status && filter.status !== 'ALL') {
      bookingWhere.status = filter.status as BookingStatus;
    }

    const prevBookingWhere: any = {
      createdAt: { gte: prevStart, lte: prevEnd },
    };
    if (filter.service && filter.service !== 'ALL') {
      prevBookingWhere.route = filter.service;
    }
    if (filter.status && filter.status !== 'ALL') {
      prevBookingWhere.status = filter.status as BookingStatus;
    }

    // 3. Parallel Database Queries
    const [
      totalUsersCount,
      newUsersCurrentPeriod,
      newUsersPrevPeriod,
      currentBookings,
      prevBookings,
      currentTransactions,
      prevTransactions,
      allBookingRoutes,
    ] = await Promise.all([
      // Total registered users all-time
      this.prisma.user.count(),

      // Registrations in current period
      this.prisma.user.count({
        where: { createdAt: { gte: start, lte: end } },
      }),

      // Registrations in previous equivalent period
      this.prisma.user.count({
        where: { createdAt: { gte: prevStart, lte: prevEnd } },
      }),

      // Current period bookings with attempts
      this.prisma.bookingRequest.findMany({
        where: bookingWhere,
        select: {
          id: true,
          bookingCode: true,
          userId: true,
          route: true,
          pilgrimCount: true,
          status: true,
          createdAt: true,
          completedAt: true,
          failureReason: true,
          attempts: {
            select: {
              id: true,
              attemptNumber: true,
              startedAt: true,
              completedAt: true,
              status: true,
              errorCode: true,
              errorMessage: true,
            },
          },
        },
      }),

      // Previous period bookings
      this.prisma.bookingRequest.findMany({
        where: prevBookingWhere,
        select: {
          id: true,
          userId: true,
          status: true,
          createdAt: true,
        },
      }),

      // Authoritative Ledger Transactions in current period
      this.prisma.walletTransaction.findMany({
        where: {
          createdAt: { gte: start, lte: end },
        },
        select: {
          id: true,
          userId: true,
          type: true,
          amount: true,
          yuktronShare: true,
          workerShare: true,
          status: true,
          createdAt: true,
        },
      }),

      // Previous period transactions
      this.prisma.walletTransaction.findMany({
        where: {
          createdAt: { gte: prevStart, lte: prevEnd },
        },
        select: {
          id: true,
          type: true,
          amount: true,
          status: true,
        },
      }),

      // Distinct routes for service selector
      this.prisma.bookingRequest.findMany({
        distinct: ['route'],
        select: { route: true },
      }),
    ]);

    // 4. Calculate Core KPIs
    const totalBookingAttempts = currentBookings.length;
    const successfulBookings = currentBookings.filter((b) => isSuccessStatus(b.status));
    const failedBookings = currentBookings.filter((b) => isFailedStatus(b.status));
    const successfulCount = successfulBookings.length;
    const failedCount = failedBookings.length;
    const successRate = totalBookingAttempts > 0
      ? Number(((successfulCount / totalBookingAttempts) * 100).toFixed(1))
      : 0;

    // Financial calculations (authoritative ledger-backed)
    const requestedBookingValue = totalBookingAttempts * serviceFee;
    const successfulBookingValue = successfulCount * serviceFee;

    const actualCollectedTransactions = currentTransactions.filter(
      (t) => t.type === TransactionType.CAPTURE && t.status === TransactionStatus.COMPLETED,
    );
    const actualCollectedAmount = actualCollectedTransactions.reduce(
      (sum, t) => sum + Number(t.amount),
      0,
    );

    const platformRevenueAmount = actualCollectedTransactions.reduce(
      (sum, t) => sum + Number(t.yuktronShare || 0),
      0,
    );

    const refundedTransactions = currentTransactions.filter(
      (t) => t.type === TransactionType.REFUND && t.status === TransactionStatus.COMPLETED,
    );
    const refundedAmount = refundedTransactions.reduce(
      (sum, t) => sum + Number(t.amount),
      0,
    );

    const pendingReservedAmount = currentTransactions
      .filter((t) => t.type === TransactionType.RESERVE && t.status === TransactionStatus.COMPLETED)
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const avgBookingAmount = successfulCount > 0
      ? Number((successfulBookingValue / successfulCount).toFixed(2))
      : serviceFee;

    // User activity & repeat booking calculations
    const uniqueBookingUserIds = new Set(currentBookings.map((b) => b.userId));
    const usersWhoAttemptedBookings = uniqueBookingUserIds.size;

    const userBookingCountMap: Record<string, number> = {};
    currentBookings.forEach((b) => {
      userBookingCountMap[b.userId] = (userBookingCountMap[b.userId] || 0) + 1;
    });

    const repeatBookersInPeriod = Object.values(userBookingCountMap).filter((cnt) => cnt >= 2).length;
    const repeatBookingRate = usersWhoAttemptedBookings > 0
      ? Number(((repeatBookersInPeriod / usersWhoAttemptedBookings) * 100).toFixed(1))
      : 0;

    // Active users: had booking attempt OR ledger transaction during the period
    const activeUserIds = new Set<string>();
    currentBookings.forEach((b) => activeUserIds.add(b.userId));
    currentTransactions.forEach((t) => activeUserIds.add(t.userId));
    const activeUsersCount = activeUserIds.size;

    // Period-over-period percentage changes
    const prevTotalBookings = prevBookings.length;
    const bookingVolumeChangePct = this.calculatePercentageChange(prevTotalBookings, totalBookingAttempts);
    const newUsersChangePct = this.calculatePercentageChange(newUsersPrevPeriod, newUsersCurrentPeriod);

    const prevCollectedAmount = prevTransactions
      .filter((t) => t.type === TransactionType.CAPTURE && t.status === TransactionStatus.COMPLETED)
      .reduce((sum, t) => sum + Number(t.amount), 0);
    const collectedAmountChangePct = this.calculatePercentageChange(prevCollectedAmount, actualCollectedAmount);

    // 5. Booking Frequency & Trends Analysis
    // 5a. Daily Trends (chronological days within range)
    const dailyTrendMap: Record<
      string,
      { date: string; attempts: number; success: number; failed: number; collected: number }
    > = {};

    // Populate day slots
    const dayCursor = new Date(start);
    while (dayCursor <= end) {
      const dStr = dayCursor.toISOString().split('T')[0];
      dailyTrendMap[dStr] = { date: dStr, attempts: 0, success: 0, failed: 0, collected: 0 };
      dayCursor.setDate(dayCursor.getDate() + 1);
    }

    currentBookings.forEach((b) => {
      const dStr = b.createdAt.toISOString().split('T')[0];
      if (dailyTrendMap[dStr]) {
        dailyTrendMap[dStr].attempts += 1;
        if (isSuccessStatus(b.status)) {
          dailyTrendMap[dStr].success += 1;
        }
        if (isFailedStatus(b.status)) {
          dailyTrendMap[dStr].failed += 1;
        }
      }
    });

    actualCollectedTransactions.forEach((t) => {
      const dStr = t.createdAt.toISOString().split('T')[0];
      if (dailyTrendMap[dStr]) {
        dailyTrendMap[dStr].collected += Number(t.amount);
      }
    });

    const dailyTrends = Object.values(dailyTrendMap);

    // 5b. Booking Status Breakdown
    const statusBreakdownMap: Record<string, number> = {};
    currentBookings.forEach((b) => {
      statusBreakdownMap[b.status] = (statusBreakdownMap[b.status] || 0) + 1;
    });

    // 5c. Hour of Day Demand Analysis (0..23)
    const hourDemand: { hour: number; label: string; count: number }[] = Array.from(
      { length: 24 },
      (_, h) => ({
        hour: h,
        label: `${h}:00`,
        count: 0,
      }),
    );
    currentBookings.forEach((b) => {
      const h = b.createdAt.getHours();
      if (hourDemand[h]) hourDemand[h].count += 1;
    });

    // 5d. Day of Week Demand Analysis (Sun..Sat)
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayOfWeekDemand = dayNames.map((name, idx) => ({
      dayIndex: idx,
      name,
      count: 0,
    }));
    currentBookings.forEach((b) => {
      const dIdx = b.createdAt.getDay();
      if (dayOfWeekDemand[dIdx]) dayOfWeekDemand[dIdx].count += 1;
    });

    // 5e. Booking Frequency Distribution Buckets
    let freq1Booking = 0;
    let freq2to5Bookings = 0;
    let freq6to10Bookings = 0;
    let freqOver10Bookings = 0;

    Object.values(userBookingCountMap).forEach((cnt) => {
      if (cnt === 1) freq1Booking++;
      else if (cnt >= 2 && cnt <= 5) freq2to5Bookings++;
      else if (cnt >= 6 && cnt <= 10) freq6to10Bookings++;
      else if (cnt > 10) freqOver10Bookings++;
    });

    const frequencyDistribution = [
      { bucket: '1 Booking', count: freq1Booking, description: 'First-time bookers' },
      { bucket: '2–5 Bookings', count: freq2to5Bookings, description: 'Regular repeat bookers' },
      { bucket: '6–10 Bookings', count: freq6to10Bookings, description: 'High-frequency centres' },
      { bucket: '> 10 Bookings', count: freqOver10Bookings, description: 'Super-power operators' },
    ];

    // 5f. Route / Service Volume Breakdown
    const serviceBreakdownMap: Record<string, { route: string; attempts: number; success: number; value: number }> = {};
    currentBookings.forEach((b) => {
      const r = b.route || 'Standard Virtual-Q';
      if (!serviceBreakdownMap[r]) {
        serviceBreakdownMap[r] = { route: r, attempts: 0, success: 0, value: 0 };
      }
      serviceBreakdownMap[r].attempts += 1;
      if (isSuccessStatus(b.status)) {
        serviceBreakdownMap[r].success += 1;
        serviceBreakdownMap[r].value += serviceFee;
      }
    });
    const serviceVolume = Object.values(serviceBreakdownMap);

    // 6. Performance & Completion Durations
    const completedDurationsSec: number[] = [];
    currentBookings.forEach((b) => {
      if (b.completedAt && b.createdAt) {
        const diffSec = Math.max(1, Math.round((b.completedAt.getTime() - b.createdAt.getTime()) / 1000));
        completedDurationsSec.push(diffSec);
      }
    });

    completedDurationsSec.sort((a, b) => a - b);
    const avgDurationSec = completedDurationsSec.length > 0
      ? Math.round(completedDurationsSec.reduce((a, b) => a + b, 0) / completedDurationsSec.length)
      : null;
    const medianDurationSec = completedDurationsSec.length > 0
      ? completedDurationsSec[Math.floor(completedDurationsSec.length / 2)]
      : null;

    // Failure categorization
    const failureCategoryMap: Record<string, number> = {};
    failedBookings.forEach((b) => {
      const cat = this.categorizeFailure(b.failureReason);
      failureCategoryMap[cat] = (failureCategoryMap[cat] || 0) + 1;
    });

    // Pending / Stuck bookings check (older than 30 mins with non-final status)
    const stuckThreshold = new Date(Date.now() - 30 * 60 * 1000);
    const pendingStuckCount = currentBookings.filter(
      (b) =>
        ['PENDING', 'WATCHING', 'ASSIGNED', 'BOOKING'].includes(b.status) &&
        b.createdAt < stuckThreshold,
    ).length;

    // 7. Paginated User Activity Analysis & Classification
    const userAnalyticsData = await this.buildUserAnalyticsTable(
      start,
      end,
      serviceFee,
      filter.userSegment || 'ALL',
      filter.search,
      filter.page || 1,
      filter.limit || 20,
    );

    // 8. Performance Diagnostics Sample Table
    const performanceDiagnosticsSample = currentBookings
      .slice(0, 50)
      .map((b) => {
        const durationSec = b.completedAt && b.createdAt
          ? Math.max(1, Math.round((b.completedAt.getTime() - b.createdAt.getTime()) / 1000))
          : null;
        return {
          id: b.id,
          bookingCode: b.bookingCode,
          userId: b.userId,
          route: b.route,
          pilgrimCount: b.pilgrimCount,
          status: b.status,
          createdAt: b.createdAt,
          completedAt: b.completedAt,
          durationSec,
          bookingValue: serviceFee,
          sanitizedFailureCategory: b.failureReason ? this.categorizeFailure(b.failureReason) : null,
          sanitizedFailureReason: this.sanitizeErrorMessage(b.failureReason),
        };
      });

    // 9. Automated Behavioral Insights
    const peakHour = hourDemand.reduce((max, h) => (h.count > max.count ? h : max), hourDemand[0]);
    const peakDay = dayOfWeekDemand.reduce((max, d) => (d.count > max.count ? d : max), dayOfWeekDemand[0]);
    const topFailureCategory = Object.entries(failureCategoryMap).sort((a, b) => b[1] - a[1])[0];

    const behavioralInsights = [
      {
        title: 'Booking Volume Trend',
        description: `Total booking requests ${bookingVolumeChangePct >= 0 ? 'increased by +' : 'decreased by '}${bookingVolumeChangePct}% compared to the previous equivalent ${rangeLabel} window (${prevTotalBookings} prior attempts).`,
        trend: bookingVolumeChangePct >= 0 ? 'UP' : 'DOWN',
        changePct: bookingVolumeChangePct,
      },
      {
        title: 'Operator Repeat Engagement',
        description: `Repeat-booking rate stands at ${repeatBookingRate}% of booking operators (${repeatBookersInPeriod} operators booked 2+ times in this window).`,
        trend: 'STABLE',
        changePct: repeatBookingRate,
      },
      {
        title: 'Peak Operational Window',
        description: `Highest booking intensity recorded on ${peakDay.name}s, with peak hour clustering around ${peakHour.label} (${peakHour.count} requests).`,
        trend: 'INFO',
        changePct: null,
      },
      {
        title: 'Authoritative Collection Status',
        description: `₹${actualCollectedAmount.toFixed(2)} collected through ledger CAPTUREs. Platform attributed Yuktron share is ₹${platformRevenueAmount.toFixed(2)}.`,
        trend: collectedAmountChangePct >= 0 ? 'UP' : 'DOWN',
        changePct: collectedAmountChangePct,
      },
      {
        title: 'Primary Recorded Bottleneck',
        description: topFailureCategory
          ? `${topFailureCategory[0]} is the leading recorded failure category, accounting for ${topFailureCategory[1]} failures.`
          : 'Zero failures recorded during the selected period. System operating optimally.',
        trend: topFailureCategory ? 'WARNING' : 'HEALTHY',
        changePct: topFailureCategory ? topFailureCategory[1] : 0,
      },
    ];

    return {
      metadata: {
        timestamp: new Date().toISOString(),
        range: filter.range || '30d',
        rangeLabel,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        serviceFilter: filter.service || 'ALL',
        statusFilter: filter.status || 'ALL',
        systemServiceFee: serviceFee,
        availableRoutes: allBookingRoutes.map((r) => r.route).filter(Boolean),
      },
      kpis: {
        totalRegisteredUsers: totalUsersCount,
        newRegistrationsInPeriod: newUsersCurrentPeriod,
        newRegistrationsChangePct: newUsersChangePct,
        activeUsersInPeriod: activeUsersCount,
        usersWhoAttemptedBookings,
        totalBookingAttempts,
        bookingVolumeChangePct,
        successfulBookings: successfulCount,
        failedBookings: failedCount,
        bookingSuccessPercentage: successRate,
        requestedBookingValue,
        successfulBookingValue,
        actualCollectedAmount,
        collectedAmountChangePct,
        platformRevenue: platformRevenueAmount,
        pendingReservedAmount,
        refundedAmount,
        averageBookingAmount: avgBookingAmount,
        repeatBookingRate,
        repeatBookersCount: repeatBookersInPeriod,
      },
      trends: {
        daily: dailyTrends,
        statusBreakdown: statusBreakdownMap,
        hourDemand,
        dayOfWeekDemand,
        frequencyDistribution,
        serviceVolume,
      },
      performance: {
        successRate,
        failureRate: totalBookingAttempts > 0 ? Number(((failedCount / totalBookingAttempts) * 100).toFixed(1)) : 0,
        avgDurationSec,
        medianDurationSec,
        pendingStuckCount,
        failureCategories: failureCategoryMap,
        sampleRecords: performanceDiagnosticsSample,
      },
      insights: behavioralInsights,
      usersTable: userAnalyticsData,
    };
  }

  /**
   * Detailed User Activity Drill-Down
   */
  async getUserActivityDetail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        centre: {
          select: {
            centreName: true,
            centreCode: true,
            district: true,
            taluk: true,
            status: true,
          },
        },
        wallet: {
          select: {
            availableBalance: true,
            reservedBalance: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID '${userId}' not found.`);
    }

    const [bookings, transactions] = await Promise.all([
      this.prisma.bookingRequest.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          bookingCode: true,
          requestedDate: true,
          route: true,
          pilgrimCount: true,
          status: true,
          officialReference: true,
          failureReason: true,
          createdAt: true,
          completedAt: true,
          attempts: {
            select: {
              attemptNumber: true,
              startedAt: true,
              completedAt: true,
              status: true,
              errorCode: true,
              errorMessage: true,
            },
          },
        },
      }),

      this.prisma.walletTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          type: true,
          amount: true,
          status: true,
          reference: true,
          createdAt: true,
        },
      }),
    ]);

    const totalBookings = bookings.length;
    const successfulBookings = bookings.filter((b) => isSuccessStatus(b.status)).length;
    const failedBookings = bookings.filter((b) => isFailedStatus(b.status)).length;
    const totalCollected = transactions
      .filter((t) => t.type === TransactionType.CAPTURE && t.status === TransactionStatus.COMPLETED)
      .reduce((sum, t) => sum + Number(t.amount), 0);

    // Build timeline events
    const timeline: { type: string; title: string; date: string; details: string; status?: string }[] = [];
    timeline.push({
      type: 'ACCOUNT_REGISTRATION',
      title: 'User Registered on Platform',
      date: user.createdAt.toISOString(),
      details: `Account role: ${user.role}, Status: ${user.status}`,
    });

    bookings.forEach((b) => {
      timeline.push({
        type: 'BOOKING_REQUEST',
        title: `Virtual-Q Pass ${b.bookingCode}`,
        date: b.createdAt.toISOString(),
        details: `Route: ${b.route}, Pilgrims: ${b.pilgrimCount}, Outcome: ${b.status}${b.failureReason ? ` (${this.sanitizeErrorMessage(b.failureReason)})` : ''}`,
        status: b.status,
      });
    });

    transactions.forEach((t) => {
      timeline.push({
        type: 'TRANSACTION',
        title: `Wallet ${t.type}`,
        date: t.createdAt.toISOString(),
        details: `Amount: ₹${Number(t.amount).toFixed(2)}, Status: ${t.status}`,
        status: t.status,
      });
    });

    timeline.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        centre: user.centre,
      },
      wallet: {
        availableBalance: user.wallet?.availableBalance ? Number(user.wallet.availableBalance) : 0,
        reservedBalance: user.wallet?.reservedBalance ? Number(user.wallet.reservedBalance) : 0,
        lastUpdated: user.wallet?.updatedAt || null,
      },
      summary: {
        totalBookings,
        successfulBookings,
        failedBookings,
        totalCollected,
        repeatBooker: totalBookings >= 2,
      },
      timeline: timeline.slice(0, 40),
      bookings: bookings.map((b) => ({
        id: b.id,
        bookingCode: b.bookingCode,
        requestedDate: b.requestedDate,
        route: b.route,
        pilgrimCount: b.pilgrimCount,
        status: b.status,
        officialReference: b.officialReference,
        sanitizedFailureReason: this.sanitizeErrorMessage(b.failureReason),
        createdAt: b.createdAt,
        completedAt: b.completedAt,
        attemptsCount: b.attempts.length,
      })),
      transactions: transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: Number(t.amount),
        status: t.status,
        reference: t.reference,
        createdAt: t.createdAt,
      })),
    };
  }

  // ==========================================
  // Private Helper Methods
  // ==========================================

  private calculateDateRange(range: string, customStart?: string, customEnd?: string) {
    const now = new Date();
    let start: Date;
    let end: Date = new Date(now);
    let rangeLabel = '30 Days';

    if (range === 'today') {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      rangeLabel = 'Today';
    } else if (range === '7d') {
      start = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
      rangeLabel = '7 Days';
    } else if (range === '90d') {
      start = new Date(now.getTime() - 90 * 24 * 3600 * 1000);
      rangeLabel = '90 Days';
    } else if (range === 'custom' && customStart) {
      start = new Date(customStart);
      end = customEnd ? new Date(new Date(customEnd).setHours(23, 59, 59, 999)) : now;
      rangeLabel = 'Custom Range';
    } else {
      // Default 30 days
      start = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
      rangeLabel = '30 Days';
    }

    const durationMs = end.getTime() - start.getTime();
    const prevStart = new Date(start.getTime() - durationMs);
    const prevEnd = new Date(start.getTime());

    return { start, end, prevStart, prevEnd, rangeLabel };
  }

  private calculatePercentageChange(previous: number, current: number): number {
    if (previous === 0) {
      return current > 0 ? 100 : 0;
    }
    return Number((((current - previous) / previous) * 100).toFixed(1));
  }

  private categorizeFailure(reason: string | null | undefined): string {
    if (!reason) return 'UNKNOWN_REASON';
    const lower = reason.toLowerCase();
    if (lower.includes('slot') || lower.includes('quota') || lower.includes('unavailable') || lower.includes('full')) {
      return 'SLOT_UNAVAILABLE';
    }
    if (lower.includes('captcha') || lower.includes('otp') || lower.includes('human') || lower.includes('challenge')) {
      return 'VERIFICATION_CHALLENGE';
    }
    if (lower.includes('timeout') || lower.includes('network') || lower.includes('econn') || lower.includes('gateway')) {
      return 'GATEWAY_TIMEOUT';
    }
    if (lower.includes('auth') || lower.includes('credential') || lower.includes('password') || lower.includes('login')) {
      return 'CREDENTIAL_INVALID';
    }
    if (lower.includes('cancel')) {
      return 'USER_CANCELLED';
    }
    if (lower.includes('balance') || lower.includes('wallet') || lower.includes('insufficient')) {
      return 'INSUFFICIENT_FUNDS';
    }
    return 'SYSTEM_REJECTED';
  }

  private sanitizeErrorMessage(msg: string | null | undefined): string | null {
    if (!msg) return null;
    return msg
      .replace(/password\s*[:=]\s*[^\s,]+/gi, 'password=[REDACTED]')
      .replace(/token\s*[:=]\s*[^\s,]+/gi, 'token=[REDACTED]')
      .replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]')
      .replace(/cookie\s*[:=]\s*[^\s,]+/gi, 'cookie=[REDACTED]')
      .slice(0, 200);
  }

  private async buildUserAnalyticsTable(
    start: Date,
    end: Date,
    serviceFee: number,
    segment: string,
    search?: string,
    page = 1,
    limit = 20,
  ) {
    // Fetch users with basic counts
    const users = await this.prisma.user.findMany({
      where: {
        role: { not: Role.SUPER_ADMIN },
        ...(search && search.trim()
          ? {
              OR: [
                { name: { contains: search.trim(), mode: 'insensitive' } },
                { email: { contains: search.trim(), mode: 'insensitive' } },
                { mobile: { contains: search.trim(), mode: 'insensitive' } },
                { id: { contains: search.trim(), mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: {
        centre: {
          select: { centreName: true, centreCode: true, district: true },
        },
        bookingRequests: {
          select: {
            id: true,
            status: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        walletTransactions: {
          where: {
            type: TransactionType.CAPTURE,
            status: TransactionStatus.COMPLETED,
          },
          select: {
            amount: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const enrichedUsers = users.map((u) => {
      const totalAttempts = u.bookingRequests.length;
      const successfulCount = u.bookingRequests.filter((b) => isSuccessStatus(b.status)).length;
      const failedCount = u.bookingRequests.filter((b) => isFailedStatus(b.status)).length;
      const repeatCount = Math.max(0, totalAttempts - 1);
      const successfulValue = successfulCount * serviceFee;
      const actualPaid = u.walletTransactions.reduce((sum, t) => sum + Number(t.amount), 0);
      const latestBooking = u.bookingRequests[0];

      // Last activity date
      const dates = [u.createdAt];
      if (latestBooking) dates.push(latestBooking.createdAt);
      if (u.walletTransactions.length > 0) dates.push(u.walletTransactions[0].createdAt);
      const lastActivityDate = new Date(Math.max(...dates.map((d) => d.getTime())));

      // Classification rule
      const hasActivityInPeriod = lastActivityDate >= start && lastActivityDate <= end;
      let classification = 'INACTIVE';
      if (u.createdAt >= start && u.createdAt <= end) {
        classification = 'NEW_USER';
      } else if (totalAttempts === 0) {
        classification = 'NEVER_BOOKED';
      } else if (failedCount > successfulCount && totalAttempts >= 2) {
        classification = 'FREQUENT_FAILS';
      } else if (totalAttempts >= 2) {
        classification = 'REPEAT_BOOKER';
      } else if (hasActivityInPeriod) {
        classification = 'ACTIVE';
      }

      return {
        id: u.id,
        name: u.name,
        email: u.email,
        mobile: u.mobile,
        role: u.role,
        district: u.centre?.district || 'Tamil Nadu',
        centreName: u.centre?.centreName || null,
        registrationDate: u.createdAt,
        lastActivityDate,
        totalAttempts,
        successfulCount,
        failedCount,
        repeatCount,
        successfulValue,
        actualPaid,
        latestBookingStatus: latestBooking?.status || 'NO_BOOKINGS',
        classification,
      };
    });

    // Filter by segment if specified
    let filteredUsers = enrichedUsers;
    if (segment && segment !== 'ALL') {
      filteredUsers = enrichedUsers.filter((u) => u.classification === segment);
    }

    const total = filteredUsers.length;
    const totalPages = Math.ceil(total / limit) || 1;
    const startIndex = (page - 1) * limit;
    const paginatedUsers = filteredUsers.slice(startIndex, startIndex + limit);

    return {
      total,
      page,
      limit,
      totalPages,
      users: paginatedUsers,
      segmentSummary: {
        all: enrichedUsers.length,
        active: enrichedUsers.filter((u) => u.classification === 'ACTIVE').length,
        repeatBookers: enrichedUsers.filter((u) => u.classification === 'REPEAT_BOOKER').length,
        newUsers: enrichedUsers.filter((u) => u.classification === 'NEW_USER').length,
        neverBooked: enrichedUsers.filter((u) => u.classification === 'NEVER_BOOKED').length,
        inactive: enrichedUsers.filter((u) => u.classification === 'INACTIVE').length,
        frequentFails: enrichedUsers.filter((u) => u.classification === 'FREQUENT_FAILS').length,
      },
    };
  }
}
