import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function testCall() {
  const br = await prisma.bookingRequest.findUnique({
    where: { id: '7b013da9-8f6a-4d95-9e3c-da8bd39a262a' },
    include: { jobs: true, transactions: true, user: true },
  });
  console.log('Booking version:', br?.version, 'status:', br?.status);

  // Let's inspect walletService.capture or stateMachine.transition for this booking
  const reserveTx = await prisma.walletTransaction.findFirst({
    where: {
      bookingId: br?.id,
      type: 'RESERVE',
      status: 'COMPLETED',
    },
  });
  console.log('reserveTx:', reserveTx);

  const wallet = await prisma.wallet.findUnique({
    where: { userId: br?.userId },
  });
  console.log('Wallet:', wallet);

  // Check partner
  const bookingUser = await prisma.user.findUnique({
    where: { id: br?.userId },
    select: { partnerId: true },
  });
  console.log('bookingUser partnerId:', bookingUser?.partnerId);
  if (bookingUser?.partnerId) {
    const partner = await (prisma as any).partner.findUnique({
      where: { id: bookingUser.partnerId },
    });
    console.log('Partner record:', partner);
  }
}

testCall().catch(console.error).finally(() => prisma.$disconnect());
