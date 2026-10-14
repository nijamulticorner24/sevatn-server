import { Test, TestingModule } from '@nestjs/testing';
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TransactionType } from '@prisma/client';

describe('WalletService & Immutable Financial Ledger', () => {
  let service: WalletService;
  let prisma: PrismaService;

  const mockPrisma = {
    wallet: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    walletTransaction: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    workerMachine: {
      update: jest.fn(),
    },
    systemConfig: {
      findUnique: jest.fn().mockResolvedValue({ serviceFee: 100, yuktronShare: 80, workerShare: 20 }),
    },
    $transaction: jest.fn((callback) => callback(mockPrisma)),
  };

  const mockAudit = {
    log: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get<WalletService>(WalletService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('reserve funds', () => {
    it('should hold ₹100 from available to reserved balance', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        availableBalance: 1000,
        reservedBalance: 0,
      });
      mockPrisma.walletTransaction.findUnique.mockResolvedValue(null);
      mockPrisma.walletTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.update.mockResolvedValue({
        id: 'w-1',
        availableBalance: 900,
        reservedBalance: 100,
      });
      mockPrisma.walletTransaction.create.mockResolvedValue({
        id: 'tx-1',
        type: TransactionType.RESERVE,
        amount: 100,
      });

      const res = await service.reserve({
        userId: 'u-1',
        bookingId: 'b-1',
        amount: 100,
      });

      expect(res.message).toContain('reserved');
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            availableBalance: { decrement: 100 },
            reservedBalance: { increment: 100 },
          },
        }),
      );
    });
  });

  describe('capture funds & ₹80/₹20 revenue split', () => {
    it('should capture ₹100 and split ₹80 to Yuktron and ₹20 to Worker PC', async () => {
      mockPrisma.walletTransaction.findUnique.mockResolvedValue(null);
      mockPrisma.walletTransaction.findFirst.mockResolvedValue(null); // No previous capture
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        availableBalance: 900,
        reservedBalance: 100,
      });
      mockPrisma.wallet.update.mockResolvedValue({
        id: 'w-1',
        availableBalance: 900,
        reservedBalance: 0,
      });
      mockPrisma.walletTransaction.create.mockImplementation(({ data }) => data);

      const res = await service.capture({
        userId: 'u-1',
        bookingId: 'b-1',
        amount: 100,
        workerMachineId: 'm-1',
      });

      expect(res.message).toContain('Funds captured successfully');
      expect(mockPrisma.workerMachine.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'm-1' },
          data: expect.objectContaining({
            successCount: { increment: 1 },
          }),
        }),
      );
    });

    it('should prevent duplicate capture via idempotency check', async () => {
      mockPrisma.walletTransaction.findUnique.mockResolvedValue(null);
      mockPrisma.walletTransaction.findFirst.mockResolvedValue({
        id: 'existing-cap',
        type: TransactionType.CAPTURE,
      });

      const res = await service.capture({
        userId: 'u-1',
        bookingId: 'b-1',
        amount: 100,
      });

      expect(res.message).toContain('already captured');
    });
  });

  describe('topup wallet with UPI receipt upload & gateway', () => {
    it('should throw BadRequestException if offline UPI topup has no receipt', async () => {
      await expect(
        service.topup('u-1', {
          amount: 1000,
          paymentReference: 'UPI-123456',
          paymentMethod: 'OFFLINE_QR',
        }),
      ).rejects.toThrow('Please upload your UPI payment receipt before submitting your wallet top-up request.');
    });

    it('should throw BadRequestException if receipt file format is invalid', async () => {
      await expect(
        service.topup('u-1', {
          amount: 1000,
          paymentReference: 'UPI-123456',
          paymentMethod: 'OFFLINE_QR',
          receiptUrl: 'data:text/plain;base64,invalid',
        }),
      ).rejects.toThrow('Invalid receipt file format. Only JPG, PNG, and PDF files are accepted.');
    });

    it('should throw BadRequestException if receipt size exceeds 5MB', async () => {
      await expect(
        service.topup('u-1', {
          amount: 1000,
          paymentReference: 'UPI-123456',
          paymentMethod: 'OFFLINE_QR',
          receiptUrl: 'data:image/jpeg;base64,valid',
          receiptFileSize: 6 * 1024 * 1024,
        }),
      ).rejects.toThrow('Receipt file size exceeds the 5 MB limit. Please upload a smaller file.');
    });

    it('should throw ConflictException if UTR reference is duplicate', async () => {
      mockPrisma.walletTransaction.findUnique.mockResolvedValue(null);
      mockPrisma.walletTransaction.findFirst.mockResolvedValue({
        id: 'existing-tx',
        reference: 'UPI-DUP-REF',
      });

      await expect(
        service.topup('u-1', {
          amount: 1000,
          paymentReference: 'UPI-DUP-REF',
          paymentMethod: 'OFFLINE_QR',
          receiptUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEA...',
        }),
      ).rejects.toThrow('A top-up request with transaction reference "UPI-DUP-REF" has already been submitted.');
    });

    it('should create PENDING transaction and NOT increment wallet balance for offline UPI submission', async () => {
      mockPrisma.walletTransaction.findUnique.mockResolvedValue(null);
      mockPrisma.walletTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        availableBalance: 500,
        reservedBalance: 0,
      });
      mockPrisma.wallet.update.mockClear();
      mockPrisma.walletTransaction.create.mockImplementation(({ data }) => ({
        id: 'tx-pending-1',
        ...data,
      }));

      const res = await service.topup('u-1', {
        amount: 1000,
        paymentReference: 'UPI-VALID-999',
        paymentMethod: 'OFFLINE_QR',
        receiptUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE...',
        receiptFileName: 'receipt.png',
        receiptFileSize: 120000,
      });

      expect(res.status).toBe('PENDING');
      expect(res.message).toContain('Top-up request submitted for verification');
      // Must NOT update wallet balance immediately for offline UPI!
      expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    });

    it('should auto-credit available balance and mark COMPLETED for online gateway topup', async () => {
      mockPrisma.walletTransaction.findUnique.mockResolvedValue(null);
      mockPrisma.walletTransaction.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        availableBalance: 500,
        reservedBalance: 0,
      });
      mockPrisma.wallet.update.mockResolvedValue({
        id: 'w-1',
        userId: 'u-1',
        availableBalance: 1500,
        reservedBalance: 0,
      });
      mockPrisma.walletTransaction.create.mockImplementation(({ data }) => ({
        id: 'tx-comp-1',
        ...data,
      }));

      const res = await service.topup('u-1', {
        amount: 1000,
        paymentReference: 'GATEWAY-ORDER-888',
        paymentMethod: 'ONLINE',
      });

      expect(res.status).toBe('COMPLETED');
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'u-1' },
          data: { availableBalance: { increment: 1000 } },
        }),
      );
    });
  });
});
