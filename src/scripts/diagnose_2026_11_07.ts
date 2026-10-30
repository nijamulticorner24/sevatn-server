import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function diagnose() {
  console.log('=== DIAGNOSING 2026-11-07 AVAILABILITY & BOOKING STATE ===');

  const opps = await prisma.availabilityOpportunity.findMany({
    where: {
      date: { contains: '2026-11-07' },
    },
  });
  console.log('AVAILABILITY OPPORTUNITIES:', JSON.stringify(opps, null, 2));

  const bookings = await prisma.bookingRequest.findMany({
    where: {
      OR: [
        { requestedDateStr: '2026-11-07' },
        {
          requestedDate: {
            gte: new Date('2026-11-06T00:00:00.000Z'),
            lte: new Date('2026-11-08T00:00:00.000Z'),
          },
        },
      ],
    },
    include: {
      jobs: true,
      account: {
        select: {
          id: true,
          username: true,
          status: true,
        },
      },
    },
  });

  console.log('BOOKINGS FOUND:', JSON.stringify(bookings.map(b => ({
    id: b.id,
    bookingCode: b.bookingCode,
    requestedDate: b.requestedDate,
    requestedDateStr: b.requestedDateStr,
    route: b.route,
    status: b.status,
    selectedTime: b.selectedTime,
    accountId: b.accountId,
    accountStatus: b.account?.status,
    jobs: b.jobs.map(j => ({
      id: j.id,
      jobType: j.jobType,
      status: j.status,
      workerId: j.workerId,
      leaseExpiresAt: j.leaseExpiresAt,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    })),
  })), null, 2));

  const locks = await prisma.accountLock.findMany();
  console.log('ACTIVE ACCOUNT LOCKS:', JSON.stringify(locks, null, 2));

  // Check all QUEUED or EXECUTION_QUEUED jobs in the system
  const allQueuedJobs = await prisma.bookingJob.findMany({
    where: {
      status: { in: ['QUEUED', 'WORKER_ASSIGNED', 'EXECUTING'] },
    },
    include: {
      bookingRequest: {
        select: {
          id: true,
          bookingCode: true,
          status: true,
          requestedDateStr: true,
        },
      },
    },
  });
  console.log('ALL QUEUED/EXECUTING JOBS:', JSON.stringify(allQueuedJobs, null, 2));
}

diagnose()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

