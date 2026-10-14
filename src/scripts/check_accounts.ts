import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function check() {
  const accounts = await prisma.bookingAccount.findMany({
    include: { user: true },
  });
  console.log('Booking Accounts found:', accounts.map(a => ({
    id: a.id,
    userId: a.userId,
    userEmail: a.user?.email,
    username: a.username,
    status: a.status,
    hasPassword: !!a.encryptedPassword,
  })));

  const bookings = await prisma.bookingRequest.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { account: true },
  });
  console.log('Recent Bookings:', bookings.map(b => ({
    id: b.id,
    bookingCode: b.bookingCode,
    status: b.status,
    requestedDate: b.requestedDateStr,
    accountId: b.accountId,
    accountUsername: b.account?.username,
  })));
}

check().catch(console.error).finally(() => prisma.$disconnect());
