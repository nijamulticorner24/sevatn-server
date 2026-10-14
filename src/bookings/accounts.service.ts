import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CredentialCrypto } from '../common/security/credential-crypto';
import { CreateAccountDto, VerifyAccountDto } from './dto/account.dto';
import { AccountStatus, BookingStatus, JobType } from '@prisma/client';

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Save or update an official Sabarimala account with authenticated encryption
   */
  async saveAccount(userId: string, dto: CreateAccountDto) {
    if (!dto.username || !dto.password) {
      throw new BadRequestException('Username and password are required');
    }

    const { encryptedData, iv, authTag } = CredentialCrypto.encrypt(dto.password);

    const account = await (this.prisma.bookingAccount as any).upsert({
      where: {
        userId_username: {
          userId,
          username: dto.username.trim(),
        },
      },
      create: {
        userId,
        username: dto.username.trim(),
        label: dto.label?.trim() || null,
        encryptedPassword: encryptedData,
        encryptionIv: iv,
        encryptionTag: authTag,
        status: AccountStatus.UNVERIFIED,
      },
      update: {
        ...(dto.label !== undefined ? { label: dto.label.trim() || null } : {}),
        encryptedPassword: encryptedData,
        encryptionIv: iv,
        encryptionTag: authTag,
        status: AccountStatus.UNVERIFIED,
        verificationNote: null,
      },
      select: {
        id: true,
        label: true,
        username: true,
        status: true,
        lastVerifiedAt: true,
        verificationNote: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    this.logger.log(`Official Sabarimala account saved: ${account.username} (ID: ${account.id})`);
    return account;
  }

  /**
   * Trigger an official account verification job on a worker terminal
   */
  async verifyAccount(userId: string, dto: VerifyAccountDto) {
    if (!dto.username || !dto.password) {
      throw new BadRequestException('Username and password are required');
    }

    const { encryptedData, iv, authTag } = CredentialCrypto.encrypt(dto.password);

    // Upsert account in VERIFYING status
    const account = await this.prisma.bookingAccount.upsert({
      where: {
        userId_username: {
          userId,
          username: dto.username.trim(),
        },
      },
      create: {
        userId,
        username: dto.username.trim(),
        encryptedPassword: encryptedData,
        encryptionIv: iv,
        encryptionTag: authTag,
        status: AccountStatus.VERIFYING,
      },
      update: {
        encryptedPassword: encryptedData,
        encryptionIv: iv,
        encryptionTag: authTag,
        status: AccountStatus.VERIFYING,
        verificationNote: 'Verification job initiated',
      },
    });

    // Create an asynchronous verification job for worker pickup
    const job = await this.prisma.bookingJob.create({
      data: {
        jobType: JobType.ACCOUNT_VERIFICATION,
        accountId: account.id,
        status: BookingStatus.QUEUED,
      },
    });

    this.logger.log(`Account verification job created: Job ${job.id} for account ${account.username}`);

    return {
      message: 'Verification job queued. Playwright worker will verify credentials on official website.',
      jobId: job.id,
      accountId: account.id,
      username: account.username,
      status: account.status,
    };
  }

  /**
   * List saved official booking accounts for centre operator (sanitized without credentials)
   */
  async listAccounts(userId: string) {
    return (this.prisma.bookingAccount as any).findMany({
      where: { userId },
      select: {
        id: true,
        label: true,
        username: true,
        status: true,
        lastVerifiedAt: true,
        verificationNote: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * Get single account details (sanitized)
   */
  async getAccountById(id: string, userId: string) {
    const account = await (this.prisma.bookingAccount as any).findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        label: true,
        username: true,
        status: true,
        lastVerifiedAt: true,
        verificationNote: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!account || account.userId !== userId) {
      throw new NotFoundException('Account not found');
    }

    return account;
  }

  /**
   * Delete saved official booking account
   */
  async deleteAccount(id: string, userId: string) {
    const account = await (this.prisma.bookingAccount as any).findUnique({
      where: { id },
      select: { id: true, userId: true, username: true },
    });

    if (!account || account.userId !== userId) {
      throw new NotFoundException('Account not found');
    }

    await (this.prisma.bookingAccount as any).delete({
      where: { id },
    });

    this.logger.log(`Devotee account deleted: ${account.username} (ID: ${id}) for user ${userId}`);
    return { success: true, message: 'Devotee profile deleted successfully' };
  }
}
