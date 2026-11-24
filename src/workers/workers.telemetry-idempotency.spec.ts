import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WorkersService } from './workers.service';

describe('WorkersService Telemetry Idempotency & Reliability Suite', () => {
  let service: WorkersService;
  let mockPrisma: any;
  let mockWorker: any;
  let mockBooking: any;

  const machineId = 'machine-uuid-001';
  const testSessionId = 'ses_1732500000000_abc123';
  const demandKey = '2026-12-05_Pamba';
  const dateStr = '2026-12-05';
  const route = 'Pamba';

  beforeEach(() => {
    mockWorker = {
      id: machineId,
      machineCode: 'PC-001',
      totalRefreshCount: 10,
      totalSuccessfulRefreshes: 8,
      totalFullResults: 8,
      totalAvailableResults: 0,
      totalUnknownResults: 0,
      totalApiErrors: 2,
    };

    mockBooking = {
      id: 'booking-req-001',
      bookingCode: 'TA-20001',
      totalRefreshCount: 5,
      lastPollSequence: 10,
      lastRefreshResult: 'FULL',
    };

    mockPrisma = {
      workerMachine: {
        findUnique: jest.fn().mockResolvedValue(mockWorker),
        update: jest.fn().mockImplementation(({ data }) => {
          if (data.totalRefreshCount?.increment) {
            mockWorker.totalRefreshCount += data.totalRefreshCount.increment;
          }
          return Promise.resolve(mockWorker);
        }),
      },
      bookingRequest: {
        findMany: jest.fn().mockResolvedValue([{ id: mockBooking.id }]),
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(mockBooking)),
        update: jest.fn().mockImplementation(({ data }) => {
          if (data.totalRefreshCount?.increment) {
            mockBooking.totalRefreshCount += data.totalRefreshCount.increment;
          }
          if (data.lastPollSequence !== undefined) {
            mockBooking.lastPollSequence = data.lastPollSequence;
          }
          if (data.lastRefreshResult !== undefined) {
            mockBooking.lastRefreshResult = data.lastRefreshResult;
          }
          return Promise.resolve(mockBooking);
        }),
      },
      monitoringPollEvent: {
        create: jest.fn().mockResolvedValue({ id: 'poll-evt-001' }),
      },
    };

    service = new WorkersService(
      mockPrisma,
      {} as any, // wallet
      {} as any, // audit
      {} as any, // notifications
      {} as any, // accountLocks
      {} as any, // smartMatcher
      {} as any, // eventsGateway
      {} as any, // allocator
      {} as any  // stateMachine
    );
  });

  it('1. Duplicate event submission: handles Prisma P2002 as expected duplicate and does not increment counters', async () => {
    // Simulate Prisma P2002 Unique Constraint Violation
    const p2002Error: any = new Error('Unique constraint failed on the constraint: MonitoringPollEvent_unique');
    p2002Error.code = 'P2002';
    mockPrisma.monitoringPollEvent.create.mockRejectedValueOnce(p2002Error);

    const result = await service.recordPollEvents(machineId, {
      workerSessionId: testSessionId,
      events: [
        {
          demandKey,
          date: dateStr,
          route,
          pollSeq: 11,
          state: 'FULL',
          durationMs: 150,
          bookingRequestIds: [mockBooking.id],
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.recorded).toBe(0);
    // WorkerMachine counters must not increment on duplicate
    expect(mockPrisma.workerMachine.update).not.toHaveBeenCalled();
    // BookingRequest counters must not increment on duplicate
    expect(mockPrisma.bookingRequest.update).not.toHaveBeenCalled();
  });

  it('2. Concurrent duplicate submission: atomic DB guard ensures only 1 succeeds', async () => {
    let callCount = 0;
    // First call succeeds, second call throws P2002
    mockPrisma.monitoringPollEvent.create.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ id: 'evt-first' });
      }
      const p2002: any = new Error('Unique violation');
      p2002.code = 'P2002';
      return Promise.reject(p2002);
    });

    const payload = {
      workerSessionId: testSessionId,
      events: [
        {
          demandKey,
          date: dateStr,
          route,
          pollSeq: 12,
          state: 'FULL',
          durationMs: 120,
          bookingRequestIds: [mockBooking.id],
        },
      ],
    };

    // Run concurrently
    const [res1, res2] = await Promise.all([
      service.recordPollEvents(machineId, payload),
      service.recordPollEvents(machineId, payload),
    ]);

    const totalRecorded = res1.recorded + res2.recorded;
    expect(totalRecorded).toBe(1);
    expect(mockWorker.totalRefreshCount).toBe(11); // incremented exactly once (10 -> 11)
  });

  it('3. Database connection failure: rethrows non-P2002 errors and does not swallow them', async () => {
    const connectionError: any = new Error('Can\'t reach database server at localhost:5432');
    connectionError.code = 'P1001';
    mockPrisma.monitoringPollEvent.create.mockRejectedValueOnce(connectionError);

    await expect(
      service.recordPollEvents(machineId, {
        workerSessionId: testSessionId,
        events: [
          {
            demandKey,
            date: dateStr,
            route,
            pollSeq: 13,
            state: 'FULL',
            durationMs: 100,
          },
        ],
      })
    ).rejects.toThrow('Can\'t reach database server');

    // Counters must not increment on DB failure
    expect(mockPrisma.workerMachine.update).not.toHaveBeenCalled();
  });

  it('4. Exactly-once counter increments: increments worker and booking counters exactly once per event', async () => {
    mockPrisma.monitoringPollEvent.create.mockResolvedValueOnce({ id: 'evt-fresh' });

    const result = await service.recordPollEvents(machineId, {
      workerSessionId: testSessionId,
      events: [
        {
          demandKey,
          date: dateStr,
          route,
          pollSeq: 14,
          state: 'AVAILABLE',
          durationMs: 200,
          bookingRequestIds: [mockBooking.id],
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.recorded).toBe(1);
    expect(mockPrisma.workerMachine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: machineId },
        data: expect.objectContaining({
          totalRefreshCount: { increment: 1 },
          totalAvailableResults: { increment: 1 },
        }),
      })
    );
    expect(mockPrisma.bookingRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: mockBooking.id },
        data: expect.objectContaining({
          totalRefreshCount: { increment: 1 },
          lastPollSequence: 14,
          lastRefreshResult: 'AVAILABLE',
        }),
      })
    );
  });

  it('5. Out-of-order poll sequences: older sequence does not overwrite newer lastPollSequence', async () => {
    mockBooking.lastPollSequence = 20;
    mockPrisma.monitoringPollEvent.create.mockResolvedValueOnce({ id: 'evt-delayed' });

    // Delayed retry sends pollSeq: 15, when current booking sequence is already 20
    const result = await service.recordPollEvents(machineId, {
      workerSessionId: testSessionId,
      events: [
        {
          demandKey,
          date: dateStr,
          route,
          pollSeq: 15, // Out of order!
          state: 'FULL',
          durationMs: 90,
          bookingRequestIds: [mockBooking.id],
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.recorded).toBe(1);
    // Booking counter increments by 1
    expect(mockPrisma.bookingRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: mockBooking.id },
        data: expect.objectContaining({
          totalRefreshCount: { increment: 1 },
        }),
      })
    );
    // But lastPollSequence was NOT overwritten with 15
    expect(mockBooking.lastPollSequence).toBe(20);
  });

  it('6. Invalid worker session IDs: rejects empty or default session ID in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';

      // Default session ID in production
      await expect(
        service.recordPollEvents(machineId, {
          workerSessionId: 'default',
          events: [],
        })
      ).rejects.toThrow(BadRequestException);

      // Empty session ID in production
      await expect(
        service.recordPollEvents(machineId, {
          workerSessionId: '',
          events: [],
        })
      ).rejects.toThrow(BadRequestException);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
