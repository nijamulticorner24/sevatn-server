import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const br = await prisma.bookingRequest.findFirst({
    where: {
      OR: [
        { officialReference: { contains: 'IVQ26112019410571880889' } },
        { officialBookingReference: { contains: 'IVQ26112019410571880889' } },
        { cartId: '1928697091' },
      ],
    },
    include: { jobs: true, transactions: true },
  });
  console.log('Booking by ref/cart:', JSON.stringify(br, null, 2));

  if (!br) {
    const recent = await prisma.bookingRequest.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: { jobs: true, transactions: true },
    });
    console.log('Recent bookings count:', recent.length);
    for (const b of recent) {
      console.log('Recent booking:', b.id, b.bookingCode, b.status, b.requestedDateStr, b.officialBookingReference, 'cartId:', b.cartId, 'jobs:', b.jobs.map((j: any) => ({ id: j.id, status: j.status, workerId: j.workerId, leaseGen: j.leaseGeneration })));
    }
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
