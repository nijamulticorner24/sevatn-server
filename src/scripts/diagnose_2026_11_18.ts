import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== DIAGNOSING 2026-11-18 BOOKING & OPPORTUNITIES ===');

  const bookings = await prisma.bookingRequest.findMany({
    where: {
      OR: [
        { requestedDateStr: '2026-11-18' },
        {
          requestedDate: {
            gte: new Date('2026-11-17T00:00:00.000Z'),
            lte: new Date('2026-11-19T00:00:00.000Z'),
          },
        },
      ],
    },
    include: {
      jobs: true,
      account: true,
      pilgrims: true,
    },
  });

  console.log(`Found ${bookings.length} booking(s) for 2026-11-18:`);
  console.log(JSON.stringify(bookings, null, 2));

  const opps = await prisma.availabilityOpportunity.findMany({
    where: {
      date: { contains: '2026-11-18' },
    },
    orderBy: { detectedAt: 'desc' },
  });
  console.log('OPPORTUNITIES FOR 2026-11-18:');
  console.log(JSON.stringify(opps, null, 2));

  const locks = await prisma.accountLock.findMany();
  console.log('ACCOUNT LOCKS:');
  console.log(JSON.stringify(locks, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

