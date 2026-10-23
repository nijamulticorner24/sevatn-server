import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TransactionType, TransactionStatus, RefundStatus, Prisma } from '@prisma/client';
import {
  TopupDto,
  ReserveFundsDto,
  CaptureFundsDto,
  ReleaseFundsDto,
  RequestRefundDto,
} from './dto/wallet.dto';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /**
   * Get or initialize a user's wallet
   */
  async getOrCreateWallet(userId: string) {
    let wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      include: {
        transactions: {
          take: 20,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!wallet) {
      wallet = await this.prisma.wallet.create({
        data: {
          userId,
          availableBalance: new Prisma.Decimal(0),
          reservedBalance: new Prisma.Decimal(0),
        },
        include: {
          transactions: {
            take: 20,
            orderBy: { createdAt: 'desc' },
          },
        },
      });
    }

    return wallet;
  }

  /**
   * TOPUP: Add funds to centre wallet (UPI / QR requires verified receipt; Online Gateway auto-credits)
   */
  async topup(userId: string, dto: TopupDto) {
    const {
      amount,
      paymentReference,
      idempotencyKey,
      paymentMethod = 'OFFLINE_QR',
      receiptUrl,
      receiptFileName,
      receiptFileSize,
    } = dto;

    if (!amount || amount < 100) {
      throw new BadRequestException('Topup amount must be at least ₹100');
    }

    const cleanRef =
      paymentReference?.trim() ||
      `REC-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    const isOffline = paymentMethod === 'OFFLINE_QR';

    const config = await this.prisma.systemConfig.findUnique({ where: { id: 'default' } });
    const onlineEnabled = config?.onlinePaymentEnabled ?? true;
    const offlineEnabled = config?.offlinePaymentEnabled ?? true;

    if (isOffline && !offlineEnabled) {
      throw new BadRequestException('Offline QR / UPI payment method is currently disabled by administrator.');
    }
    if (!isOffline && !onlineEnabled) {
      throw new BadRequestException('Online payment gateway method is currently disabled by administrator.');
    }
    if (!onlineEnabled && !offlineEnabled) {
      throw new BadRequestException('All payment methods are currently disabled by administrator.');
    }

    // Validate receipt for UPI / QR submissions
    if (isOffline) {
      if (!receiptUrl || !receiptUrl.trim()) {
        throw new BadRequestException(
          'Please upload your UPI payment receipt before submitting your wallet top-up request.',
        );
      }

      // Validate file type & content format (JPG, PNG, PDF)
      const validPrefixes = [
        'data:image/jpeg',
        'data:image/jpg',
        'data:image/png',
        'data:application/pdf',
      ];
      const isDataUrl = receiptUrl.startsWith('data:');
      const isHttpUrl = receiptUrl.startsWith('http://') || receiptUrl.startsWith('https://');

      if (isDataUrl) {
        const hasValidMime = validPrefixes.some((prefix) =>
          receiptUrl.toLowerCase().startsWith(prefix),
        );
        if (!hasValidMime) {
          throw new BadRequestException(
            'Invalid receipt file format. Only JPG, PNG, and PDF files are accepted.',
          );
        }

        // Validate file size (max 5 MB)
        const base64Content = receiptUrl.split(',')[1] || '';
        const approximateBytes = Math.ceil((base64Content.length * 3) / 4);
        if (approximateBytes > 5.5 * 1024 * 1024) {
          throw new BadRequestException(
            'Receipt file size exceeds the 5 MB limit. Please upload a smaller file.',
          );
        }
      } else if (!isHttpUrl) {
        throw new BadRequestException(
          'Invalid receipt file format. Please upload a valid JPG, PNG, or PDF receipt.',
        );
      }

      if (receiptFileSize && receiptFileSize > 5 * 1024 * 1024) {
        throw new BadRequestException(
          'Receipt file size exceeds the 5 MB limit. Please upload a smaller file.',
        );
      }
    }

    // Check idempotency if key provided
    if (idempotencyKey) {
      const existingTx = await this.prisma.walletTransaction.findUnique({
        where: { idempotencyKey },
      });
      if (existingTx) {
        return {
          message: 'Topup already processed (idempotent)',
          transaction: existingTx,
          status: existingTx.status,
        };
      }
    }

    // Check for duplicate UTR references in active/pending transactions
    const duplicateTx = await this.prisma.walletTransaction.findFirst({
      where: {
        reference: cleanRef,
        status: { in: [TransactionStatus.PENDING, TransactionStatus.COMPLETED] },
      },
    });
    if (duplicateTx) {
      throw new ConflictException(
        `A top-up request with transaction reference "${cleanRef}" has already been submitted.`,
      );
    }

    // Sanitize receipt filename to prevent executable or directory traversal names
    const safeFileName = receiptFileName
      ? receiptFileName.replace(/[^a-zA-Z0-9._-]/g, '_')
      : `receipt_${Date.now()}`;

    return await this.prisma.$transaction(async (tx) => {
      let wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) {
        wallet = await tx.wallet.create({
          data: {
            userId,
            availableBalance: new Prisma.Decimal(0),
            reservedBalance: new Prisma.Decimal(0),
          },
        });
      }

      // ONLY credit available balance if ONLINE gateway.
      // OFFLINE UPI submissions remain PENDING until authorised verification!
      let updatedWallet = wallet;
      if (!isOffline) {
        updatedWallet = await tx.wallet.update({
          where: { userId },
          data: {
            availableBalance: { increment: amount },
          },
        });
      }

      const txStatus = isOffline ? TransactionStatus.PENDING : TransactionStatus.COMPLETED;

      const transaction = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          userId,
          type: TransactionType.TOPUP,
          amount: new Prisma.Decimal(amount),
          status: txStatus,
          reference: cleanRef,
          idempotencyKey: idempotencyKey || undefined,
          metadata: {
            note: isOffline
              ? 'Centre Wallet Topup (UPI / QR Proof Submitted)'
              : 'Centre Wallet Topup (Online Gateway)',
            paymentMethod,
            receiptUrl: receiptUrl || null,
            receiptFileName: safeFileName,
            receiptFileSize: receiptFileSize || null,
            submittedAt: new Date().toISOString(),
          },
        },
      });

      await this.audit.log({
        actorId: userId,
        actorType: 'USER',
        action: isOffline ? 'WALLET_TOPUP_SUBMITTED' : 'WALLET_TOPUP',
        entity: 'WalletTransaction',
        entityId: transaction.id,
        metadata: {
          amount,
          reference: cleanRef,
          status: txStatus,
          hasReceipt: !!receiptUrl,
          newBalance: updatedWallet.availableBalance,
        },
      });

      return {
        message: isOffline
          ? 'Top-up request submitted for verification. Your wallet will be credited once your receipt is verified.'
          : 'Topup successful',
        wallet: updatedWallet,
        transaction,
        status: txStatus,
      };
    });
  }

  /**
   * Authoritative Verification: Admin verifies pending UPI topup and credits wallet
   */
  async verifyTopup(adminUserId: string, transactionId: string) {
    return await this.prisma.$transaction(async (tx) => {
      const transaction = await tx.walletTransaction.findUnique({
        where: { id: transactionId },
      });

      if (!transaction) {
        throw new NotFoundException('Top-up transaction not found');
      }

      if (transaction.status === TransactionStatus.COMPLETED) {
        return { message: 'Transaction already verified', transaction };
      }

      if (transaction.status !== TransactionStatus.PENDING) {
        throw new BadRequestException(`Cannot verify transaction in ${transaction.status} status`);
      }

      const updatedWallet = await tx.wallet.update({
        where: { id: transaction.walletId },
        data: {
          availableBalance: { increment: transaction.amount },
        },
      });

      const updatedTx = await tx.walletTransaction.update({
        where: { id: transactionId },
        data: {
          status: TransactionStatus.COMPLETED,
          metadata: {
            ...((transaction.metadata as any) || {}),
            verifiedBy: adminUserId,
            verifiedAt: new Date().toISOString(),
          },
        },
      });

      await this.audit.log({
        actorId: adminUserId,
        actorType: 'ADMIN',
        action: 'WALLET_TOPUP_VERIFIED',
        entity: 'WalletTransaction',
        entityId: transaction.id,
        metadata: {
          amount: transaction.amount,
          reference: transaction.reference,
          newBalance: updatedWallet.availableBalance,
        },
      });

      return {
        message: 'Top-up transaction verified and wallet credited successfully',
        wallet: updatedWallet,
        transaction: updatedTx,
      };
    });
  }

  /**
   * Admin rejects pending top-up
   */
  async rejectTopup(adminUserId: string, transactionId: string, reason?: string) {
    const transaction = await this.prisma.walletTransaction.findUnique({
      where: { id: transactionId },
    });

    if (!transaction) {
      throw new NotFoundException('Top-up transaction not found');
    }

    if (transaction.status !== TransactionStatus.PENDING) {
      throw new BadRequestException(`Cannot reject transaction in ${transaction.status} status`);
    }

    const updatedTx = await this.prisma.walletTransaction.update({
      where: { id: transactionId },
      data: {
        status: TransactionStatus.FAILED,
        metadata: {
          ...((transaction.metadata as any) || {}),
          rejectedBy: adminUserId,
          rejectedAt: new Date().toISOString(),
          rejectionReason: reason || 'Invalid or unverified payment proof',
        },
      },
    });

    await this.audit.log({
      actorId: adminUserId,
      actorType: 'ADMIN',
      action: 'WALLET_TOPUP_REJECTED',
      entity: 'WalletTransaction',
      entityId: transaction.id,
      metadata: {
        amount: transaction.amount,
        reference: transaction.reference,
        reason: reason || 'Invalid or unverified payment proof',
      },
    });

    return {
      message: 'Top-up transaction rejected successfully',
      transaction: updatedTx,
    };
  }

  /**
   * RESERVE: Hold funds when booking is queued/started
   */
  async reserve(dto: ReserveFundsDto) {
    const { userId, bookingId, amount, idempotencyKey } = dto;

    if (idempotencyKey) {
      const existing = await this.prisma.walletTransaction.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        return { message: 'Reservation already processed (idempotent)', transaction: existing };
      }
    }

    return await this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) {
        throw new NotFoundException('Wallet not found');
      }

      if (Number(wallet.availableBalance) < amount) {
        throw new BadRequestException(
          `Insufficient available balance. Required: ₹${amount}, Available: ₹${wallet.availableBalance}`,
        );
      }

      // Check if reservation already active for this booking
      const activeReserve = await tx.walletTransaction.findFirst({
        where: {
          bookingId,
          type: TransactionType.RESERVE,
          status: TransactionStatus.COMPLETED,
        },
      });

      if (activeReserve) {
        return { message: 'Funds already reserved for this booking', transaction: activeReserve };
      }

      const updatedWallet = await tx.wallet.update({
        where: { userId },
        data: {
          availableBalance: { decrement: amount },
          reservedBalance: { increment: amount },
        },
      });

      const transaction = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          userId,
          bookingId,
          type: TransactionType.RESERVE,
          amount: new Prisma.Decimal(amount),
          status: TransactionStatus.COMPLETED,
          reference: `RES-${bookingId.slice(0, 8)}`,
          idempotencyKey: idempotencyKey || undefined,
          metadata: { bookingId },
        },
      });

      return { message: 'Funds reserved successfully', wallet: updatedWallet, transaction };
    });
  }

  /**
   * CAPTURE: Finalize charge on verified booking success with ₹80/₹20 revenue split
   */
  async capture(dto: CaptureFundsDto) {
    const { userId, bookingId, amount, workerMachineId, idempotencyKey } = dto;

    if (idempotencyKey) {
      const existing = await this.prisma.walletTransaction.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        return { message: 'Capture already processed (idempotent)', transaction: existing };
      }
    }

    return await this.prisma.$transaction(async (tx) => {
      // Idempotency check on booking capture: NEVER ALLOW DUPLICATE CAPTURE
      const existingCapture = await tx.walletTransaction.findFirst({
        where: {
          bookingId,
          type: TransactionType.CAPTURE,
          status: TransactionStatus.COMPLETED,
        },
      });

      if (existingCapture) {
        this.logger.warn(`Capture attempted on already captured booking: ${bookingId}`);
        return { message: 'Booking already captured', transaction: existingCapture };
      }

      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) {
        throw new NotFoundException('Wallet not found');
      }

      // Ensure we have reserved funds to capture
      if (Number(wallet.reservedBalance) < amount) {
        // Fallback: If not reserved, check available balance
        if (Number(wallet.availableBalance) >= amount) {
          await tx.wallet.update({
            where: { userId },
            data: { availableBalance: { decrement: amount } },
          });
        } else {
          throw new BadRequestException('Insufficient wallet balance to capture');
        }
      } else {
        await tx.wallet.update({
          where: { userId },
          data: { reservedBalance: { decrement: amount } },
        });
      }

      // Standard Flat Fee Capture: 100% Platform Assistance Fee
      const yuktronShare = new Prisma.Decimal(amount.toFixed(2));
      const workerShare = new Prisma.Decimal(0);

      const transaction = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          userId,
          bookingId,
          type: TransactionType.CAPTURE,
          amount: new Prisma.Decimal(amount),
          yuktronShare,
          workerShare,
          status: TransactionStatus.COMPLETED,
          reference: `CAP-${bookingId.slice(0, 8)}`,
          idempotencyKey: idempotencyKey || undefined,
          metadata: {
            workerMachineId,
            fee: amount,
          },
        },
      });

      // Update worker machine success count if machine known
      if (workerMachineId) {
        await tx.workerMachine.update({
          where: { id: workerMachineId },
          data: {
            successCount: { increment: 1 },
          },
        });
      }

      await this.audit.log({
        actorId: userId,
        actorType: 'SYSTEM',
        action: 'WALLET_CAPTURE',
        entity: 'WalletTransaction',
        entityId: transaction.id,
        metadata: { bookingId, amount },
      });

      return { message: 'Funds captured successfully', transaction };
    });
  }

  /**
   * RELEASE: Unreserve funds when booking is unsuccessful, expired or cancelled
   */
  async release(dto: ReleaseFundsDto) {
    const { userId, bookingId, amount, reason, idempotencyKey } = dto;

    if (idempotencyKey) {
      const existing = await this.prisma.walletTransaction.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        return { message: 'Release already processed (idempotent)', transaction: existing };
      }
    }

    return await this.prisma.$transaction(async (tx) => {
      // Check if already released
      const existingRelease = await tx.walletTransaction.findFirst({
        where: {
          bookingId,
          type: TransactionType.RELEASE,
          status: TransactionStatus.COMPLETED,
        },
      });

      if (existingRelease) {
        return { message: 'Funds already released for this booking', transaction: existingRelease };
      }

      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) {
        throw new NotFoundException('Wallet not found');
      }

      // Check how much is currently reserved
      const releaseAmount = Math.min(Number(wallet.reservedBalance), amount);
      if (releaseAmount > 0) {
        await tx.wallet.update({
          where: { userId },
          data: {
            reservedBalance: { decrement: releaseAmount },
            availableBalance: { increment: releaseAmount },
          },
        });
      }

      const transaction = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          userId,
          bookingId,
          type: TransactionType.RELEASE,
          amount: new Prisma.Decimal(releaseAmount),
          status: TransactionStatus.COMPLETED,
          reference: `REL-${bookingId.slice(0, 8)}`,
          idempotencyKey: idempotencyKey || undefined,
          metadata: { reason: reason || 'Booking terminated without capture' },
        },
      });

      await this.audit.log({
        actorId: userId,
        actorType: 'SYSTEM',
        action: 'WALLET_RELEASE',
        entity: 'WalletTransaction',
        entityId: transaction.id,
        metadata: { bookingId, releaseAmount, reason },
      });

      return { message: 'Funds released back to available balance', transaction };
    });
  }

  /**
   * Request Refund for eligible wallet balance (Limited to 4 times per calendar month)
   */
  async requestRefund(userId: string, dto: RequestRefundDto) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet || Number(wallet.availableBalance) < dto.amount) {
      throw new BadRequestException('Insufficient available balance for refund');
    }

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

    // Enforce monthly limit: Maximum 4 refund requests per calendar month
    const monthlyRefundsCount = await this.prisma.refundRequest.count({
      where: {
        userId,
        createdAt: { gte: startOfMonth },
        status: { not: RefundStatus.REJECTED },
      },
    });

    const MAX_MONTHLY_REFUNDS = 4;
    if (monthlyRefundsCount >= MAX_MONTHLY_REFUNDS) {
      throw new BadRequestException(
        `Monthly refund limit reached. You can only submit up to ${MAX_MONTHLY_REFUNDS} refund requests per calendar month (${monthlyRefundsCount}/${MAX_MONTHLY_REFUNDS} used this month). Limit resets on the 1st of next month.`,
      );
    }

    const refund = await this.prisma.refundRequest.create({
      data: {
        userId,
        amount: new Prisma.Decimal(dto.amount),
        reason: dto.reason,
        upiId: dto.upiId?.trim() || null,
      },
    });

    return refund;
  }

  /**
   * Get full ledger transactions for a user
   */
  async getTransactions(userId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const [transactions, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where: { userId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { booking: { select: { bookingCode: true, route: true, requestedDate: true } } },
      }),
      this.prisma.walletTransaction.count({ where: { userId } }),
    ]);

    return { transactions, total, page, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Financial Summary (for Admin and Ledger reconciliation)
   */
  async getFinancialLedgerSummary() {
    const [totals, counts] = await Promise.all([
      this.prisma.walletTransaction.groupBy({
        by: ['type'],
        _sum: {
          amount: true,
          yuktronShare: true,
          workerShare: true,
        },
      }),
      this.prisma.walletTransaction.count(),
    ]);

    let totalTopups = 0;
    let totalReserved = 0;
    let totalCaptured = 0;
    let totalReleased = 0;
    let totalRefunded = 0;
    let yuktronRevenue = 0;
    let workerSettlement = 0;

    for (const group of totals) {
      const sum = Number(group._sum.amount || 0);
      if (group.type === TransactionType.TOPUP) totalTopups += sum;
      if (group.type === TransactionType.RESERVE) totalReserved += sum;
      if (group.type === TransactionType.CAPTURE) {
        totalCaptured += sum;
        yuktronRevenue += Number(group._sum.yuktronShare || 0);
        workerSettlement += Number(group._sum.workerShare || 0);
      }
      if (group.type === TransactionType.RELEASE) totalReleased += sum;
      if (group.type === TransactionType.REFUND) totalRefunded += sum;
    }

    return {
      totalTopups,
      totalReserved,
      totalCaptured,
      totalReleased,
      totalRefunded,
      yuktronRevenue,
      workerSettlement,
      transactionCount: counts,
    };
  }
}
