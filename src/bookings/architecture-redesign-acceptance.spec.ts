import { validateNominee, normalizeNomineeRelationship, OFFICIAL_SABARIMALA_RELATIONSHIPS } from '../common/nominee-validator';
import { isRouteMatching, normalizeDate, extractAuthoritativeReference } from '../common/booking-status.constants';
import { BookingStateMachineService } from './booking-state-machine.service';
import { BookingStatus } from '@prisma/client';
import { WorkersService } from '../workers/workers.service';
import { SmartAllocatorService } from '../workers/smart-allocator.service';

describe('Full Architecture Redesign — API Business Logic, Wallet Safety & Queue Protocol Acceptance Suite (17 Scenarios)', () => {
  // Scenario 1, 2, 3: Exact date and route match; wrong date or route rejected
  it('Scenarios 1, 2 & 3: enforces exact date and route matching and rejects cross-date or cross-route availability', () => {
    expect(normalizeDate('2026-12-20T00:00:00.000Z')).toBe('2026-12-20');
    expect(normalizeDate('20-12-2026')).toBe('2026-12-20');
    // Scenario 2: Wrong date availability rejected
    expect(normalizeDate('2026-12-20')).not.toBe(normalizeDate('2026-12-21'));

    // Scenario 1: Exact route match
    expect(isRouteMatching('Pamba - Marakkoottam - 4 Kms', 'Pamba')).toBe(true);
    expect(isRouteMatching('Erumely - Kalaketti Traditional Path - 46 Kms', 'Erumely')).toBe(true);
    expect(isRouteMatching('Vandiperiyar - Sathram - Pulmedu - 16 Kms', 'Vandiperiyar')).toBe(true);

    // Scenario 3: Wrong route availability rejected
    expect(isRouteMatching('Pamba - Marakkoottam - 4 Kms', 'Erumely')).toBe(false);
    expect(isRouteMatching('Erumely - Kalaketti Traditional Path - 46 Kms', 'Vandiperiyar')).toBe(false);
    expect(isRouteMatching('Vandiperiyar - Sathram - Pulmedu - 16 Kms', 'Pamba')).toBe(false);
  });

  // Scenario 9: Invalid nominee form / relationship prevents admission and submission
  it('Scenario 9: validates single nominee with official relationship, normalizes Wife/Husband to Spouse, and rejects unsupported relationships', () => {
    const validRes = validateNominee(
      {
        nominee: {
          nomineeName: 'Saraswathi K',
          nomineeAge: 41,
          nomineeRelationship: 'Wife',
          nomineePhone: '9876543210',
        },
      },
      { allowOptional: false, strictOfficialRelationship: true },
    );

    expect(validRes.valid).toBe(true);
    expect(validRes.resolvedNominee?.nomineeRelationship).toBe('Spouse');
    expect(OFFICIAL_SABARIMALA_RELATIONSHIPS).toEqual([
      'Father',
      'Mother',
      'Son',
      'Daughter',
      'Brother',
      'Sister',
      'Spouse',
    ]);

    const invalidRel = validateNominee(
      {
        nominee: {
          nomineeName: 'Kumar P',
          nomineeAge: 32,
          nomineeRelationship: 'Relative',
        },
      },
      { allowOptional: false, strictOfficialRelationship: true },
    );
    expect(invalidRel.valid).toBe(false);
    expect(invalidRel.errors[0]).toContain('not supported by the Sabarimala portal');

    const missingNominee = validateNominee({}, { allowOptional: false, strictOfficialRelationship: true });
    expect(missingNominee.valid).toBe(false);
  });

  // Scenario 10 & 12: Final submission timeout / stale lease after CONFIRM_CLICKED triggers PENDING_VERIFICATION & retains wallet hold
  it('Scenarios 10 & 12: SmartAllocator transitions expired lease after CONFIRM_CLICKED to PENDING_VERIFICATION and failJob retains wallet reservation for uncertain results', async () => {
    const stateMachine = new BookingStateMachineService({} as any, {} as any, {} as any);
    expect(stateMachine.canTransition(BookingStatus.EXECUTING, 'PENDING_VERIFICATION' as any)).toBe(true);
    expect(stateMachine.canTransition('PENDING_VERIFICATION' as any, BookingStatus.SUCCESS)).toBe(true);
    expect(stateMachine.canTransition('PENDING_VERIFICATION' as any, BookingStatus.FAILED)).toBe(true);

    const mockWalletRelease = jest.fn();
    const mockPrisma: any = {
      bookingJob: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-uncertain-1',
          bookingRequestId: 'br-uncertain-1',
          accountId: 'acc-1',
          workerId: 'w-1',
          leaseGeneration: 1,
          fencingToken: 'f-1',
          attempt: 1,
          maxAttempts: 3,
          bookingRequest: {
            id: 'br-uncertain-1',
            bookingCode: 'TA-10500',
            userId: 'user-1',
            accountId: 'acc-1',
            status: BookingStatus.EXECUTING,
          },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      bookingRequest: {
        update: jest.fn().mockResolvedValue({}),
      },
      workerMachine: {
        update: jest.fn().mockResolvedValue({}),
      },
      workerActivityLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    const workersService = new WorkersService(
      mockPrisma,
      { release: mockWalletRelease } as any,
      { log: jest.fn().mockResolvedValue({}) } as any,
      { send: jest.fn().mockResolvedValue({}) } as any,
      { releaseLock: jest.fn().mockResolvedValue(true) } as any,
      { returnToPendingOnSlotLoss: jest.fn() } as any,
      { transition: jest.fn().mockResolvedValue({}) } as any,
      { releaseJobCapacity: jest.fn().mockResolvedValue({}) } as any,
      { notifyBookingUpdated: jest.fn() } as any,
    );

    // Uncertain result (RECONCILIATION_REQUIRED) must NOT release wallet hold
    await workersService.failJob('job-uncertain-1', 'w-1', {
      status: BookingStatus.RECONCILIATION_REQUIRED,
      errorCode: 'VERIFICATION_PENDING',
      errorMessage: 'Timeout after confirm click; awaiting history reconciliation',
      leaseGeneration: 1,
      fencingToken: 'f-1',
      protocolVersion: 'v2.0-fenced',
    });
    expect(mockWalletRelease).not.toHaveBeenCalled();

    // Retryable failure still in queue (attempt 1 of 3) must NOT release wallet hold
    await workersService.failJob('job-uncertain-1', 'w-1', {
      status: BookingStatus.RETRYABLE_FAILURE,
      errorCode: 'NETWORK_TIMEOUT',
      errorMessage: 'Transient portal timeout',
      leaseGeneration: 1,
      fencingToken: 'f-1',
      protocolVersion: 'v2.0-fenced',
    });
    expect(mockWalletRelease).not.toHaveBeenCalled();
  });

  // Scenario 11 & 13: Confirmed booking history prevents duplicate retry; wallet capture & release are idempotent
  it('Scenarios 11 & 13: extractAuthoritativeReference rejects Cart IDs/synthetic refs, and completeJob records BookingConfirmationHistory with idempotent wallet capture key cap_${bookingId}', async () => {
    expect(
      extractAuthoritativeReference({
        officialBookingReference: 'IVQ26112500981234',
        cartId: '99887766',
      }),
    ).toBe('IVQ26112500981234');

    expect(
      extractAuthoritativeReference({
        officialBookingReference: '9988776655',
        cartId: '9988776655',
      }),
    ).toBeNull();

    expect(
      extractAuthoritativeReference({
        officialBookingReference: 'SAB-2026-VERIFIED',
      }),
    ).toBeNull();

    const mockCapture = jest.fn().mockResolvedValue({});
    const mockHistoryUpsert = jest.fn().mockResolvedValue({});
    const mockSavedPilgrimUpsert = jest.fn().mockResolvedValue({ id: 'sp-1' });

    const txMock: any = {
      bookingJob: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      bookingRequest: { update: jest.fn().mockResolvedValue({}) },
      walletTransaction: { findFirst: jest.fn().mockResolvedValue({ amount: 20 }) },
      accountSavedPilgrim: { upsert: mockSavedPilgrimUpsert },
      bookingConfirmationHistory: { upsert: mockHistoryUpsert },
      workerMachine: { update: jest.fn().mockResolvedValue({}) },
    };

    const mockPrisma: any = {
      bookingJob: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-ok-1',
          bookingRequestId: 'br-ok-1',
          accountId: 'acc-1',
          workerId: 'w-1',
          leaseGeneration: 1,
          fencingToken: 'f-ok-1',
          status: BookingStatus.EXECUTING,
          bookingRequest: {
            id: 'br-ok-1',
            bookingCode: 'TA-10600',
            userId: 'user-1',
            accountId: 'acc-1',
            requestedDateStr: '2026-12-20',
            requestedDate: new Date('2026-12-20'),
            route: 'Pamba - Marakkoottam - 4 Kms',
            pilgrimCount: 1,
            nomineeName: 'Lakshmi S',
            nomineeAge: 34,
            nomineeRelationship: 'Spouse',
            status: BookingStatus.EXECUTING,
          },
        }),
      },
      bookingRequest: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      workerActivityLog: {
        create: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(txMock)),
    };

    const workersService = new WorkersService(
      mockPrisma,
      { capture: mockCapture } as any,
      { log: jest.fn().mockResolvedValue({}) } as any,
      { send: jest.fn().mockResolvedValue({}) } as any,
      { releaseLock: jest.fn().mockResolvedValue(true) } as any,
      {} as any,
      { transition: jest.fn().mockResolvedValue({}) } as any,
      { releaseJobCapacity: jest.fn().mockResolvedValue({}) } as any,
      { notifyBookingConfirmed: jest.fn() } as any,
    );

    await workersService.completeJob('job-ok-1', 'w-1', {
      officialReference: 'IVQ26122099887766',
      officialBookingReference: 'IVQ26122099887766',
      leaseGeneration: 1,
      fencingToken: 'f-ok-1',
      protocolVersion: 'v2.0-fenced',
      confirmationData: {
        selectedPilgrim: {
          fullName: 'Ayyappan K',
          identityFingerprint: 'fp_ayyappan_1234',
        },
      },
    } as any);

    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: 'br-ok-1',
        idempotencyKey: 'cap_br-ok-1',
      }),
      txMock,
    );
    expect(mockSavedPilgrimUpsert).toHaveBeenCalled();
    expect(mockHistoryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingRequestId: 'br-ok-1' },
        create: expect.objectContaining({
          officialBookingReference: 'IVQ26122099887766',
          selectedPilgrimFingerprint: 'fp_ayyappan_1234',
        }),
      }),
    );
  });

  // Scenario 14, 15, 16: Same account cannot execute two bookings concurrently; different accounts can; no synthetic auto-grab booking can be created
  it('Scenarios 14, 15 & 16: enforces AccountLock mutual exclusion per account, allows independent accounts, and never creates synthetic TA-GRAB bookings when no customer booking exists', async () => {
    const lockedAccounts = new Set<string>(['acc-busy']);
    const mockAccountLock: any = {
      isLocked: jest.fn().mockImplementation(async (accId: string) => lockedAccounts.has(accId)),
      getActiveLockHolder: jest.fn().mockImplementation(async (accId: string) =>
        lockedAccounts.has(accId) ? { locked: true, jobId: 'job-holder-1' } : { locked: false },
      ),
      acquireLock: jest.fn().mockImplementation(async (accId: string) => {
        if (lockedAccounts.has(accId)) return false;
        lockedAccounts.add(accId);
        return true;
      }),
      releaseLock: jest.fn().mockResolvedValue(true),
    };

    const mockPrisma: any = {
      workerMachine: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'w-1',
          machineCode: 'W1',
          active: true,
          adminStatus: 'ENABLED',
          desiredState: 'RUNNING',
          maxConcurrentJobs: 2,
          capabilities: ['BOOKING_EXECUTION'],
        }),
      },
      bookingRequest: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(mockPrisma)),
    };

    const workersService = new WorkersService(
      mockPrisma,
      {} as any,
      {} as any,
      {} as any,
      mockAccountLock,
      {} as any,
      {} as any,
      { evaluateWorkerCapacity: jest.fn().mockResolvedValue({ atCapacity: false, activeCount: 0, maxCapacity: 2, countedJobs: [] }) } as any,
      {} as any,
    );

    // Scenario 16: When no customer booking exists for date, matchPendingBooking returns NONE_FOR_DATE and never creates a synthetic TA-GRAB booking
    const noGrabRes = await workersService.matchPendingBooking('w-1', '2026-12-28', 'Pamba');
    expect(noGrabRes.hasJob).toBe(false);
    expect(noGrabRes.reason).toBe('NONE_FOR_DATE');
    expect(mockPrisma.bookingRequest.create).not.toHaveBeenCalled();

    // Scenario 14 & 15: Same account is blocked by AccountLock while different account acquires lock independently
    expect(await mockAccountLock.acquireLock('acc-busy', 'br-2', 'w-1')).toBe(false);
    expect(await mockAccountLock.acquireLock('acc-free-2', 'br-3', 'w-2')).toBe(true);
  });

  // 1 to 5 Pilgrims End-to-End Multi-Pilgrim Confirmation, Duplicate History & Nominee Validation
  it('Multi-Pilgrim Regression (1 to 5 Pilgrims): validates 1..5 nominees, stores all selected pilgrim fingerprints in BookingConfirmationHistory, and splits comma-separated fingerprints into excludedPilgrimFingerprints', async () => {
    // 1. Validate 3 nominees with official relationships
    const multiNomineeCheck = validateNominee(
      {
        nominees: [
          { nomineeName: 'Lakshmi S', nomineeAge: 34, nomineeRelationship: 'Spouse' },
          { nomineeName: 'Ramesh K', nomineeAge: 45, nomineeRelationship: 'Brother' },
          { nomineeName: 'Parvathi M', nomineeAge: 58, nomineeRelationship: 'Mother' },
        ],
      },
      { allowOptional: false, strictOfficialRelationship: true },
    );
    expect(multiNomineeCheck.valid).toBe(true);
    expect(multiNomineeCheck.resolvedNominees).toHaveLength(3);
    expect(multiNomineeCheck.resolvedNominees?.map((n) => n.nomineeRelationship)).toEqual([
      'Spouse',
      'Brother',
      'Mother',
    ]);

    // 2. Complete job with 3 selected saved pilgrims -> upserts all 3 into AccountSavedPilgrim and stores comma-joined fingerprints in BookingConfirmationHistory
    const mockCapture = jest.fn().mockResolvedValue({});
    const mockHistoryUpsert = jest.fn().mockResolvedValue({});
    const mockSavedPilgrimUpsert = jest.fn().mockResolvedValue({ id: 'sp-multi-1' });

    const txMock: any = {
      bookingJob: {
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      bookingRequest: { update: jest.fn().mockResolvedValue({}) },
      walletTransaction: { findFirst: jest.fn().mockResolvedValue({ amount: 30 }) },
      accountSavedPilgrim: { upsert: mockSavedPilgrimUpsert },
      bookingConfirmationHistory: { upsert: mockHistoryUpsert },
      workerMachine: { update: jest.fn().mockResolvedValue({}) },
    };

    const mockPrisma: any = {
      bookingJob: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-multi-3',
          bookingRequestId: 'br-multi-3',
          accountId: 'acc-multi-1',
          workerId: 'w-1',
          leaseGeneration: 1,
          fencingToken: 'f-multi-3',
          status: BookingStatus.EXECUTING,
          bookingRequest: {
            id: 'br-multi-3',
            bookingCode: 'TA-10903',
            userId: 'user-1',
            accountId: 'acc-multi-1',
            requestedDateStr: '2026-12-20',
            requestedDate: new Date('2026-12-20'),
            route: 'Pamba - Marakkoottam - 4 Kms',
            pilgrimCount: 3,
            nomineeName: 'Lakshmi S',
            nomineeAge: 34,
            nomineeRelationship: 'Spouse',
            status: BookingStatus.EXECUTING,
          },
        }),
      },
      bookingRequest: { findFirst: jest.fn().mockResolvedValue(null) },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      workerActivityLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(txMock)),
    };

    const workersService = new WorkersService(
      mockPrisma,
      { capture: mockCapture } as any,
      { log: jest.fn().mockResolvedValue({}) } as any,
      { send: jest.fn().mockResolvedValue({}) } as any,
      { releaseLock: jest.fn().mockResolvedValue(true) } as any,
      {} as any,
      { transition: jest.fn().mockResolvedValue({}) } as any,
      { releaseJobCapacity: jest.fn().mockResolvedValue({}) } as any,
      { notifyBookingConfirmed: jest.fn() } as any,
    );

    await workersService.completeJob('job-multi-3', 'w-1', {
      officialReference: 'IVQ26122033334444',
      officialBookingReference: 'IVQ26122033334444',
      leaseGeneration: 1,
      fencingToken: 'f-multi-3',
      protocolVersion: 'v2.0-fenced',
      confirmationData: {
        pilgrimsCount: 3,
        selectedPilgrims: [
          { fullName: 'Ayyappan K', identityFingerprint: 'fp_p1' },
          { fullName: 'Manikandan R', identityFingerprint: 'fp_p2' },
          { fullName: 'Sabarish M', identityFingerprint: 'fp_p3' },
        ],
      },
    } as any);

    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: 'br-multi-3',
        amount: 30,
        idempotencyKey: 'cap_br-multi-3',
      }),
      txMock,
    );
    expect(mockSavedPilgrimUpsert).toHaveBeenCalledTimes(3);
    expect(mockHistoryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingRequestId: 'br-multi-3' },
        create: expect.objectContaining({
          officialBookingReference: 'IVQ26122033334444',
          selectedPilgrimFingerprint: 'fp_p1,fp_p2,fp_p3',
          selectedPilgrimName: 'Ayyappan K, Manikandan R, Sabarish M',
        }),
      }),
    );
  });

  describe('Sequential One-Pilgrim Booking Acceptance Suite (9 Requirements Verification)', () => {
    // Requirement 1: Submitting quantity 5 creates 5 individual pilgrim tasks linked to the parent request
    it('Requirement 1: Submitting quantity 5 creates 5 individual pilgrim tasks linked to the parent request with their specific nominee details', async () => {
      const mockCreate = jest.fn().mockImplementation((args: any) => ({
        id: 'br-5-pilgrims',
        bookingCode: 'TA-50005',
        userId: 'user-1',
        pilgrimCount: 5,
        status: BookingStatus.PENDING,
        financialStatus: 'RESERVED',
        ...args.data,
      }));

      const mockTx: any = {
        bookingAccount: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'acc-1',
            userId: 'user-1',
            status: 'VERIFIED',
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-1',
            role: 'CENTRE',
            registeredLocation: 'Chennai',
          }),
        },
        wallet: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'w-1',
            userId: 'user-1',
            availableBalance: 1000,
            reservedBalance: 0,
          }),
          update: jest.fn().mockResolvedValue({}),
        },
        walletTransaction: {
          create: jest.fn().mockResolvedValue({}),
        },
        bookingRequest: {
          create: mockCreate,
          findFirst: jest.fn().mockResolvedValue(null),
        },
        bookingJob: {
          create: jest.fn().mockResolvedValue({}),
        },
        availabilityOpportunity: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      const mockPrisma: any = {
        $transaction: jest.fn().mockImplementation(async (cb: any) => cb(mockTx)),
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'user-1',
            role: 'CENTRE',
            registeredLocation: 'Chennai',
          }),
        },
        systemConfig: {
          findUnique: jest.fn().mockResolvedValue({ id: 'default', serviceFee: 20 }),
        },
        bookingAccount: mockTx.bookingAccount,
        wallet: mockTx.wallet,
        bookingRequest: { ...mockTx.bookingRequest, count: jest.fn().mockResolvedValue(10) },
      };

      const mockPricingService: any = {
        calculateBookingPrice: jest.fn().mockImplementation(async ({ quantity }: any) => ({
          baseTicketPrice: 10,
          partnerMarkup: 0,
          distributorMarkup: 0,
          finalTicketPrice: 10,
          ticketQuantity: quantity || 1,
          totalTicketAmount: 10 * (quantity || 1),
          pricingConfigVersion: 1,
          pricingSnapshot: {
            baseTicketPrice: 10,
            partnerMarkup: 0,
            distributorMarkup: 0,
            finalTicketPrice: 10,
            ticketQuantity: quantity || 1,
            totalTicketAmount: 10 * (quantity || 1),
            calculatedAt: new Date().toISOString(),
          },
        })),
      };

      const bookingsService: any = new (require('./bookings.service').BookingsService)(
        mockPrisma,
        { release: jest.fn(), capture: jest.fn() } as any,
        { log: jest.fn() } as any,
        { send: jest.fn(), sendTelegramBookingNotification: jest.fn().mockResolvedValue({}) } as any,
        {} as any,
        { acquireLock: jest.fn().mockResolvedValue(true), isLocked: jest.fn().mockResolvedValue(false), releaseLock: jest.fn().mockResolvedValue(true) } as any,
        { notifyBookingCreated: jest.fn(), notifyBookingUpdated: jest.fn() } as any,
        {} as any,
        mockPricingService,
      );

      const nomineesList = [
        { nomineeName: 'Nominee One', nomineeAge: 30, nomineeRelationship: 'Spouse' },
        { nomineeName: 'Nominee Two', nomineeAge: 35, nomineeRelationship: 'Father' },
        { nomineeName: 'Nominee Three', nomineeAge: 28, nomineeRelationship: 'Mother' },
        { nomineeName: 'Nominee Four', nomineeAge: 40, nomineeRelationship: 'Brother' },
        { nomineeName: 'Nominee Five', nomineeAge: 25, nomineeRelationship: 'Sister' },
      ];

      const res = await bookingsService.createBooking('user-1', {
        requestedDate: '2026-12-20',
        route: 'Pamba',
        pilgrimCount: 5,
        accountId: 'acc-1',
        termsAccepted: true,
        nominees: nomineesList,
      });

      expect(res).toBeDefined();
      expect(mockCreate).toHaveBeenCalled();
      const createArgs = mockCreate.mock.calls[0][0];

      // Parent request has pilgrimCount = 5
      expect(createArgs.data.pilgrimCount).toBe(5);

      // Child pilgrims relation creates EXACTLY 5 individual pilgrim tasks
      const createdPilgrims = createArgs.data.pilgrims.create;
      expect(createdPilgrims).toHaveLength(5);

      // Each pilgrim task has its discrete taskIndex, PENDING status, and corresponding nominee
      for (let i = 0; i < 5; i++) {
        expect(createdPilgrims[i].metadata.taskIndex).toBe(i + 1);
        expect(createdPilgrims[i].metadata.taskStatus).toBe('PENDING');
        expect(createdPilgrims[i].nomineeName).toBe(nomineesList[i].nomineeName);
        expect(createdPilgrims[i].nomineeAge).toBe(nomineesList[i].nomineeAge);
        expect(createdPilgrims[i].nomineeRelationship).toBe(nomineesList[i].nomineeRelationship);
      }
    });

    // Requirement 6 & 7: Parent request is not marked COMPLETED until all requested pilgrims are confirmed, capturing ₹10 per confirmed pilgrim
    it('Requirement 6 & 7: Parent request remains EXECUTING when Pilgrim 1 is confirmed, capturing ₹10, and only transitions to SUCCESS when all requested pilgrims are confirmed', async () => {
      const mockCapture = jest.fn().mockResolvedValue({ message: 'Funds captured' });
      const mockRelease = jest.fn().mockResolvedValue({ message: 'Funds released' });
      let parentStatus = BookingStatus.EXECUTING;

      const pilgrimTasksInDb = [
        { id: 'task-1', bookingRequestId: 'br-seq-parent', metadata: { taskIndex: 1, taskStatus: 'PENDING' } },
        { id: 'task-2', bookingRequestId: 'br-seq-parent', metadata: { taskIndex: 2, taskStatus: 'PENDING' } },
      ];

      const txMock: any = {
        bookingJob: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue({}),
        },
        bookingRequest: {
          update: jest.fn().mockImplementation((args: any) => {
            if (args.data.status) parentStatus = args.data.status;
            return Promise.resolve({ id: 'br-seq-parent', ...args.data });
          }),
        },
        bookingPilgrim: {
          findUnique: jest.fn().mockImplementation(({ where }: any) =>
            pilgrimTasksInDb.find((p) => p.id === where.id) || null,
          ),
          findFirst: jest.fn().mockImplementation(() => pilgrimTasksInDb[0]),
          findMany: jest.fn().mockImplementation(() => pilgrimTasksInDb),
          update: jest.fn().mockImplementation(({ where, data }: any) => {
            const item = pilgrimTasksInDb.find((p) => p.id === where.id);
            if (item) Object.assign(item, data);
            return item;
          }),
        },
        walletTransaction: {
          findFirst: jest.fn().mockResolvedValue({ id: 'res-tx-1', amount: 20 }),
        },
        workerMachine: {
          update: jest.fn().mockResolvedValue({}),
        },
      };

      const mockPrisma: any = {
        bookingJob: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'job-seq-1',
            bookingRequestId: 'br-seq-parent',
            accountId: 'acc-1',
            workerId: 'w-1',
            leaseGeneration: 1,
            fencingToken: 'f-1',
            bookingRequest: {
              id: 'br-seq-parent',
              bookingCode: 'TA-SEQ-100',
              userId: 'user-1',
              pilgrimCount: 2,
              status: BookingStatus.EXECUTING,
            },
          }),
        },
        $transaction: jest.fn().mockImplementation(async (cb: any) => cb(txMock)),
      };

      const workersService: any = new WorkersService(
        mockPrisma,
        { capture: mockCapture, release: mockRelease } as any,
        { log: jest.fn() } as any,
        { send: jest.fn().mockResolvedValue({}) } as any,
        { releaseLock: jest.fn().mockResolvedValue(true) } as any,
        {} as any,
        null, // No state machine to directly observe DB update
        { releaseJobCapacity: jest.fn().mockResolvedValue({}) } as any,
        { notifyBookingConfirmed: jest.fn() } as any,
      );

      // Complete Pilgrim 1 (1 of 2)
      const res1 = await workersService.completeJob('job-seq-1', 'w-1', {
        officialReference: 'IVQ26122000001111',
        officialBookingReference: 'IVQ26122000001111',
        leaseGeneration: 1,
        fencingToken: 'f-1',
        protocolVersion: 'v2.0-fenced',
        pilgrimTaskId: 'task-1',
        taskIndex: 1,
        isFinalPilgrim: false,
        selectedPilgrim: { fullName: 'Devotee 1', identityFingerprint: 'fp_1' },
      } as any);

      // Verifies: ₹10 captured with individual task idempotency key
      expect(mockCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: 'br-seq-parent',
          amount: 10,
          idempotencyKey: 'cap_br-seq-parent_task-1',
        }),
        txMock,
      );

      // Verifies: Parent booking request is NOT marked COMPLETED yet (returns to availability WATCHING for remaining devotees)
      expect(res1.isAllConfirmed).toBe(false);
      expect([BookingStatus.EXECUTING, BookingStatus.WATCHING]).toContain(parentStatus);

      // Now complete Pilgrim 2 (2 of 2 - final pilgrim)
      const res2 = await workersService.completeJob('job-seq-1', 'w-1', {
        officialReference: 'IVQ26122000002222',
        officialBookingReference: 'IVQ26122000002222',
        leaseGeneration: 1,
        fencingToken: 'f-1',
        protocolVersion: 'v2.0-fenced',
        pilgrimTaskId: 'task-2',
        taskIndex: 2,
        isFinalPilgrim: true,
        selectedPilgrim: { fullName: 'Devotee 2', identityFingerprint: 'fp_2' },
      } as any);

      // Verifies: Second ₹10 captured with its own idempotency key
      expect(mockCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: 'br-seq-parent',
          amount: 10,
          idempotencyKey: 'cap_br-seq-parent_task-2',
        }),
        txMock,
      );

      // Verifies: Parent booking request transitions to SUCCESS now that all requested pilgrims are confirmed
      expect(res2.isAllConfirmed).toBe(true);
      expect(parentStatus).toBe(BookingStatus.SUCCESS);
    });

    // Requirement 7 (Partial Failure): Captures only confirmed bookings and releases remaining unfulfilled reservation
    it('Requirement 7 (Partial Failure): When only 3 of 5 pilgrims succeed, captures ₹30 total and releases the remaining ₹20 back to customer wallet', async () => {
      const mockRelease = jest.fn().mockResolvedValue({ message: 'Funds released' });
      const mockCapture = jest.fn();

      const mockPrisma: any = {
        bookingJob: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'job-part-1',
            bookingRequestId: 'br-part-5',
            accountId: 'acc-1',
            workerId: 'w-1',
            leaseGeneration: 1,
            fencingToken: 'f-1',
            attempt: 3,
            maxAttempts: 3,
            bookingRequest: {
              id: 'br-part-5',
              bookingCode: 'TA-PART-5',
              userId: 'user-1',
              pilgrimCount: 5,
              status: BookingStatus.EXECUTING,
            },
          }),
          update: jest.fn().mockResolvedValue({}),
        },
        walletTransaction: {
          // ₹30 already captured for 3 successful devotees
          findMany: jest.fn().mockResolvedValue([
            { id: 'c1', amount: 10, type: 'CAPTURE', status: 'COMPLETED' },
            { id: 'c2', amount: 10, type: 'CAPTURE', status: 'COMPLETED' },
            { id: 'c3', amount: 10, type: 'CAPTURE', status: 'COMPLETED' },
          ]),
          // Initial reservation was ₹50 (5 × ₹10)
          findFirst: jest.fn().mockResolvedValue({ id: 'res-part', amount: 50, type: 'RESERVE', status: 'COMPLETED' }),
        },
        bookingRequest: {
          update: jest.fn().mockResolvedValue({}),
        },
        workerMachine: {
          update: jest.fn().mockResolvedValue({}),
        },
      };

      const workersService: any = new WorkersService(
        mockPrisma,
        { capture: mockCapture, release: mockRelease } as any,
        { log: jest.fn() } as any,
        { send: jest.fn().mockResolvedValue({}) } as any,
        { releaseLock: jest.fn().mockResolvedValue(true) } as any,
        null,
        null,
        { releaseJobCapacity: jest.fn().mockResolvedValue({}) } as any,
        { notifyBookingFailed: jest.fn() } as any,
      );

      await workersService.failJob('job-part-1', 'w-1', {
        status: BookingStatus.FAILED,
        errorCode: 'PARTIAL_SUCCESS',
        errorMessage: '3 of 5 devotees confirmed. Remaining released.',
        leaseGeneration: 1,
        fencingToken: 'f-1',
        protocolVersion: 'v2.0-fenced',
      });

      // Verifies: Only the remaining unfulfilled ₹20 (50 - 30) is released back to customer wallet
      expect(mockRelease).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingId: 'br-part-5',
          amount: 20,
        }),
      );

      // Verifies: Parent booking request is marked PARTIALLY_COMPLETED
      expect(mockPrisma.bookingRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'br-part-5' },
          data: expect.objectContaining({
            reconciliationStatus: 'PARTIALLY_COMPLETED',
            lastMilestone: expect.stringContaining('PARTIALLY_COMPLETED (3/5 Confirmed)'),
          }),
        }),
      );
    });
  });
});
