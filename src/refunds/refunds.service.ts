import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AuditService } from '../audit/audit.service';
import { RefundStatus, Role, TransactionType, TransactionStatus, Prisma } from '@prisma/client';

@Injectable()
export class RefundsService {
  constructor(
    private prisma: PrismaService,
    private walletService: WalletService,
    private audit: AuditService,
  ) {}

  async getRefunds(user: any, status?: RefundStatus) {
    const where: any = {};
    if (user.role === Role.CENTRE) {
      where.userId = user.id;
    }
    if (status) {
      where.status = status;
    }

    return this.prisma.refundRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { name: true, email: true, mobile: true, centre: { select: { centreName: true, district: true } } } },
      },
    });
  }

  async processRefund(
    id: string,
    action: 'APPROVE' | 'REJECT',
    data: { adminNotes?: string; reference?: string; proofUrl?: string } = {},
    adminUser: any,
  ) {
    const refund = await this.prisma.refundRequest.findUnique({
      where: { id },
      include: { user: { include: { wallet: true } } },
    });

    if (!refund) {
      throw new NotFoundException('Refund request not found');
    }

    if (refund.status !== RefundStatus.REQUESTED && refund.status !== RefundStatus.UNDER_REVIEW) {
      throw new BadRequestException(`Refund request already ${refund.status}`);
    }

    const adminNotes = data.adminNotes || '';
    const reference = data.reference?.trim() || `BANK-REF-${Date.now()}`;
    const proofUrl = data.proofUrl || null;

    if (action === 'APPROVE') {
      const amount = Number(refund.amount);
      const available = Number(refund.user.wallet?.availableBalance || 0);

      if (available < amount) {
        throw new BadRequestException('User wallet has insufficient available balance for refund payout');
      }

      await this.prisma.$transaction(async (tx) => {
        // Deduct from wallet
        await tx.wallet.update({
          where: { userId: refund.userId },
          data: { availableBalance: { decrement: amount } },
        });

        // Record refund ledger transaction
        await tx.walletTransaction.create({
          data: {
            walletId: refund.user.wallet.id,
            userId: refund.userId,
            type: TransactionType.REFUND,
            amount: new Prisma.Decimal(amount),
            status: TransactionStatus.COMPLETED,
            reference,
            metadata: {
              refundRequestId: refund.id,
              upiId: refund.upiId,
              proofUrl,
              adminNotes,
              settledBy: adminUser.email || adminUser.name,
              settledAt: new Date().toISOString(),
            },
          },
        });

        // Update refund request status
        await tx.refundRequest.update({
          where: { id },
          data: {
            status: RefundStatus.PROCESSED,
            processedAt: new Date(),
            adminNotes,
            reference,
            proofUrl,
          },
        });
      });

      await this.audit.log({
        actorId: adminUser.id,
        actorType: 'ADMIN',
        action: 'REFUND_APPROVED_AND_PROCESSED',
        entity: 'RefundRequest',
        entityId: refund.id,
        metadata: { amount, userId: refund.userId, reference, hasProof: !!proofUrl },
      });

      return { message: 'Refund approved, balance deducted, and payout settled successfully' };
    } else {
      await this.prisma.refundRequest.update({
        where: { id },
        data: {
          status: RefundStatus.REJECTED,
          processedAt: new Date(),
          adminNotes,
        },
      });

      await this.audit.log({
        actorId: adminUser.id,
        actorType: 'ADMIN',
        action: 'REFUND_REJECTED',
        entity: 'RefundRequest',
        entityId: refund.id,
        metadata: { adminNotes, userId: refund.userId },
      });

      return { message: 'Refund request rejected' };
    }
  }
}
