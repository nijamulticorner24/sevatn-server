import { Test, TestingModule } from '@nestjs/testing';
import { BookingStateMachineService } from './booking-state-machine.service';
import { PrismaService } from '../prisma/prisma.service';
import { BookingStatus, ExecutionStatus, FinancialStatus } from '@prisma/client';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

describe('BookingStateMachineService', () => {
  let service: BookingStateMachineService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      bookingRequest: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      bookingMilestone: {
        create: jest.fn(),
      },
      $transaction: jest.fn((callback) => callback(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingStateMachineService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<BookingStateMachineService>(BookingStateMachineService);
  });

  it('should allow valid transitions', () => {
    expect(service.canTransition(BookingStatus.PENDING, BookingStatus.EXECUTION_QUEUED)).toBe(true);
    expect(service.canTransition(BookingStatus.EXECUTION_QUEUED, BookingStatus.WORKER_ASSIGNED)).toBe(true);
    expect(service.canTransition(BookingStatus.WORKER_ASSIGNED, BookingStatus.EXECUTING)).toBe(true);
    expect(service.canTransition(BookingStatus.EXECUTING, BookingStatus.SUCCESS)).toBe(true);
    expect(service.canTransition(BookingStatus.WORKER_ERROR, BookingStatus.CANCELLED)).toBe(true);
    expect(service.canTransition(BookingStatus.WORKER_ERROR, BookingStatus.PENDING)).toBe(true);
    expect(service.canTransition(BookingStatus.WORKER_ERROR, BookingStatus.QUEUED)).toBe(true);
    expect(service.canTransition(BookingStatus.SITE_ERROR, BookingStatus.CANCELLED)).toBe(true);
    expect(service.canTransition(BookingStatus.TIMEOUT, BookingStatus.CANCELLED)).toBe(true);
  });

  it('should reject invalid transitions', () => {
    expect(service.canTransition(BookingStatus.SUCCESS, BookingStatus.PENDING)).toBe(false);
    expect(service.canTransition(BookingStatus.CANCELLED, BookingStatus.EXECUTING)).toBe(false);
  });

  it('should atomically update status and increment version', async () => {
    prisma.bookingRequest.findUnique.mockResolvedValue({
      id: 'book-1',
      bookingCode: 'TA-10001',
      status: BookingStatus.PENDING,
      version: 1,
    });

    prisma.bookingRequest.update.mockResolvedValue({
      id: 'book-1',
      bookingCode: 'TA-10001',
      status: BookingStatus.EXECUTION_QUEUED,
      version: 2,
    });

    const res = await service.transition({
      bookingId: 'book-1',
      targetStatus: BookingStatus.EXECUTION_QUEUED,
      expectedVersion: 1,
      milestone: 'DATE_SELECTED',
    });

    expect(res.success).toBe(true);
    expect(res.previousStatus).toBe(BookingStatus.PENDING);
    expect(res.newStatus).toBe(BookingStatus.EXECUTION_QUEUED);
    expect(res.version).toBe(2);
    expect(prisma.bookingMilestone.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bookingRequestId: 'book-1',
          milestone: 'DATE_SELECTED',
        }),
      }),
    );
  });

  it('should throw ConflictException on version mismatch', async () => {
    prisma.bookingRequest.findUnique.mockResolvedValue({
      id: 'book-1',
      bookingCode: 'TA-10001',
      status: BookingStatus.PENDING,
      version: 2,
    });

    await expect(
      service.transition({
        bookingId: 'book-1',
        targetStatus: BookingStatus.EXECUTION_QUEUED,
        expectedVersion: 1,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('should throw BadRequestException on invalid transition', async () => {
    prisma.bookingRequest.findUnique.mockResolvedValue({
      id: 'book-1',
      bookingCode: 'TA-10001',
      status: BookingStatus.SUCCESS,
      version: 1,
    });

    await expect(
      service.transition({
        bookingId: 'book-1',
        targetStatus: BookingStatus.PENDING,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should allow operator to transition booking from WORKER_ERROR to CANCELLED', async () => {
    prisma.bookingRequest.findUnique.mockResolvedValue({
      id: 'book-10047',
      bookingCode: 'TA-10047',
      status: BookingStatus.WORKER_ERROR,
      version: 3,
    });

    prisma.bookingRequest.update.mockResolvedValue({
      id: 'book-10047',
      bookingCode: 'TA-10047',
      status: BookingStatus.CANCELLED,
      version: 4,
    });

    const res = await service.transition({
      bookingId: 'book-10047',
      targetStatus: BookingStatus.CANCELLED,
      expectedVersion: 3,
      note: 'Cancelled by operator',
    });

    expect(res.success).toBe(true);
    expect(res.previousStatus).toBe(BookingStatus.WORKER_ERROR);
    expect(res.newStatus).toBe(BookingStatus.CANCELLED);
    expect(res.version).toBe(4);
  });
});

