const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  try {
    const migrations = await prisma.$queryRawUnsafe('SELECT migration_name, finished_at, applied_steps_count FROM _prisma_migrations ORDER BY started_at ASC');
    console.log('Migrations in DB:', JSON.stringify(migrations, null, 2));
  } catch(e) {
    console.log('Error querying _prisma_migrations:', e.message);
  }
  const accounts = await prisma.bookingAccount.findMany({ select: { id: true, username: true, status: true, verificationNote: true } });
  console.log('Accounts in DB (' + accounts.length + '):', JSON.stringify(accounts, null, 2));

  const bookings = await prisma.bookingRequest.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, bookingCode: true, status: true, requestedDate: true, route: true, pilgrimCount: true, requiresHumanNote: true, failureReason: true, officialReference: true }
  });
  console.log('Recent bookings in DB (' + bookings.length + '):', JSON.stringify(bookings, null, 2));

  await prisma.$disconnect();
}
check();

