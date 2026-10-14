import { PrismaClient, BookingStatus, TransactionType, TransactionStatus, Prisma, WorkerStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function clearAllQueues() {
  console.log('🧹 Starting cleanup of all pending queues, jobs, and holds...\n');

  // 1. Fetch all pending/active BookingRequests
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
    BookingStatus.WISHLIST_ADDED,
    BookingStatus.CHECKING_AVAILABILITY,
    BookingStatus.WATCHING,
    BookingStatus.WAITING,
    BookingStatus.AVAILABILITY_FOUND,
    BookingStatus.BOOKING_IN_PROGRESS,
    BookingStatus.BOOKING,
    BookingStatus.CONFIRMATION_CHECK,
    BookingStatus.REQUIRES_HUMAN,
  ];

  const pendingRequests = await prisma.bookingRequest.findMany({
    where: { status: { in: activeStatuses } },
  });

  console.log(`📌 Found ${pendingRequests.length} active/pending BookingRequests.`);

  for (const booking of pendingRequests) {
    // Check if reserve exists and needs release
    const activeReserve = await prisma.walletTransaction.findFirst({
      where: {
        bookingId: booking.id,
        type: TransactionType.RESERVE,
        status: TransactionStatus.COMPLETED,
      },
    });

    const existingRelease = await prisma.walletTransaction.findFirst({
      where: {
        bookingId: booking.id,
        type: TransactionType.RELEASE,
        status: TransactionStatus.COMPLETED,
      },
    });

    const existingCapture = await prisma.walletTransaction.findFirst({
      where: {
        bookingId: booking.id,
        type: TransactionType.CAPTURE,
        status: TransactionStatus.COMPLETED,
      },
    });

    if (activeReserve && !existingRelease && !existingCapture) {
      const wallet = await prisma.wallet.findUnique({ where: { userId: booking.userId } });
      if (wallet) {
        const releaseAmount = Math.min(Number(wallet.reservedBalance), Number(activeReserve.amount));
        if (releaseAmount > 0) {
          await prisma.wallet.update({
            where: { userId: booking.userId },
            data: {
              reservedBalance: { decrement: releaseAmount },
              availableBalance: { increment: releaseAmount },
            },
          });

          await prisma.walletTransaction.create({
            data: {
              walletId: wallet.id,
              userId: booking.userId,
              bookingId: booking.id,
              type: TransactionType.RELEASE,
              amount: new Prisma.Decimal(releaseAmount),
              status: TransactionStatus.COMPLETED,
              reference: `REL-${booking.id.slice(0, 8)}`,
              metadata: { reason: 'Queue cleared by admin' },
            },
          });
          console.log(`  💰 Released ₹${releaseAmount} hold back to wallet for user ${booking.userId} (Booking #${booking.bookingCode})`);
        }
      }
    }

    // Cancel booking request
    await prisma.bookingRequest.update({
      where: { id: booking.id },
      data: {
        status: BookingStatus.CANCELLED,
        assignedMachineId: null,
        leaseExpiresAt: null,
        leaseStartedAt: null,
        failureReason: 'Queue cleared by admin/operator',
      },
    });
    console.log(`  ❌ Cancelled BookingRequest #${booking.bookingCode} (${booking.id})`);
  }

  // 2. Cancel all active/pending BookingJobs
  const cancelledJobs = await prisma.bookingJob.updateMany({
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
  console.log(`\n📌 Cancelled ${cancelledJobs.count} active/pending BookingJobs.`);

  // 3. Clear all Account Locks
  const clearedLocks = await prisma.accountLock.deleteMany({});
  console.log(`📌 Cleared ${clearedLocks.count} Account Locks.`);

  // 4. Clear any pending Availability Opportunities
  const clearedOpps = await prisma.availabilityOpportunity.deleteMany({
    where: { status: 'AVAILABLE' },
  });
  console.log(`📌 Cleared ${clearedOpps.count} unconsumed Availability Opportunities.`);

  // 5. Reset all Worker Machines
  const workers = await prisma.workerMachine.findMany();
  for (const worker of workers) {
    const isOnline = worker.active && worker.lastHeartbeat && (Date.now() - new Date(worker.lastHeartbeat).getTime() < 60000);
    await prisma.workerMachine.update({
      where: { id: worker.id },
      data: {
        currentJobId: null,
        status: isOnline ? WorkerStatus.ONLINE : WorkerStatus.OFFLINE,
      },
    });
  }
  console.log(`📌 Reset ${workers.length} Worker Machines to clean idle status.`);

  console.log('\n✅ ALL PENDING QUEUES AND JOBS CLEARED SUCCESSFULLY!');
}

clearAllQueues()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
