import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- DIAGNOSING TA-10027 ---');
  
  const booking = await prisma.bookingRequest.findFirst({
    where: { bookingCode: { contains: '10027' } },
    include: { jobs: true, account: true, pilgrims: true }
  });
  console.log('BOOKING TA-10027:');
  console.log(JSON.stringify(booking, null, 2));

  const allQueued = await prisma.bookingJob.findMany({
    where: { status: 'QUEUED' },
    include: { bookingRequest: true, account: true, worker: true }
  });
  console.log(`\nALL QUEUED JOBS COUNT: ${allQueued.length}`);
  console.log(JSON.stringify(allQueued, null, 2));

  const allJobs = await prisma.bookingJob.findMany({
    take: 10,
    orderBy: { createdAt: 'desc' },
    include: { bookingRequest: true, account: true, worker: true }
  });
  console.log(`\nLATEST 10 JOBS:`);
  console.log(JSON.stringify(allJobs, null, 2));

  const workers = await prisma.workerMachine.findMany();
  console.log(`\nREGISTERED WORKER MACHINES:`);
  console.log(JSON.stringify(workers.map(w => ({
    id: w.id,
    machineCode: w.machineCode,
    active: w.active,
    status: w.status,
    adminStatus: w.adminStatus,
    currentActiveJobs: w.currentActiveJobs,
    maxConcurrentJobs: w.maxConcurrentJobs,
    capabilities: w.capabilities
  })), null, 2));

  const locks = await prisma.accountLock.findMany();
  console.log(`\nACTIVE ACCOUNT LOCKS:`);
  console.log(JSON.stringify(locks, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

