import { PrismaClient, Role, UserStatus, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Starting Database Purge (Clearing all transactions and users except SUPER_ADMIN)...');

  // 1. First, find or ensure the SUPER_ADMIN
  let superAdmin = await prisma.user.findFirst({
    where: { role: Role.SUPER_ADMIN },
  });

  const passwordHash = await bcrypt.hash('Admin@123456', 10);

  if (!superAdmin) {
    console.log('Creating default Super Admin user...');
    superAdmin = await prisma.user.create({
      data: {
        id: 'cb75ce11-ab7b-49dd-9038-be51871f2bb3',
        name: 'Super Admin',
        email: 'superadmin@ticketassist.in',
        mobile: '9876543210',
        passwordHash,
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
    });
  } else {
    // Reset Super Admin password and status
    superAdmin = await prisma.user.update({
      where: { id: superAdmin.id },
      data: {
        passwordHash,
        status: UserStatus.ACTIVE,
      },
    });
    console.log(`Found existing Super Admin: ${superAdmin.email} (${superAdmin.id})`);
  }

  // 2. Clear all transactional and operational tables
  console.log('🧹 Purging transactional tables...');

  // Delete all wallet transactions and ledger entries
  await prisma.walletTransaction.deleteMany({});
  await prisma.walletLedgerEntry.deleteMany({});
  console.log('✓ Wallet transactions and ledger entries cleared.');

  // Delete all bookings and related logs
  await prisma.bookingMilestone.deleteMany({});
  await prisma.bookingAttempt.deleteMany({});
  await prisma.bookingJob.deleteMany({});
  await prisma.bookingPilgrim.deleteMany({});
  await prisma.bookingReconciliation.deleteMany({});
  await prisma.bookingRequest.deleteMany({});
  console.log('✓ All bookings and booking jobs cleared.');

  // Delete worker activities and allocations
  await prisma.jobAllocationLog.deleteMany({});
  await prisma.workerActivityLog.deleteMany({});
  await prisma.accountLock.deleteMany({});
  await prisma.bookingAccount.deleteMany({});
  await prisma.workerMachine.deleteMany({});
  console.log('✓ Worker allocations, accounts, and machines cleared.');

  // Delete discovery & availability
  await prisma.availabilityOpportunity.deleteMany({});
  await prisma.discoverySchedule.deleteMany({});
  await prisma.instantServiceQuery.deleteMany({});
  console.log('✓ Availability & schedules cleared.');

  // Delete payouts, refunds, notifications, idempotency, audit logs
  await prisma.partnerPayout.deleteMany({});
  await prisma.distributorPayout.deleteMany({});
  await prisma.refundRequest.deleteMany({});
  await prisma.notificationEvent.deleteMany({});
  await prisma.idempotencyRecord.deleteMany({});
  await prisma.outboxEvent.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.pricingAuditLog.deleteMany({});
  console.log('✓ Payouts, refunds, notifications, and audit logs cleared.');

  // Delete invitations
  await prisma.partnerInvitation.deleteMany({});
  await prisma.distributorInvitation.deleteMany({});
  console.log('✓ Invitations cleared.');

  // 3. Clear business hierarchy (Centres, Distributors, Partners)
  await prisma.centre.deleteMany({});
  console.log('✓ Centres cleared.');

  await prisma.distributor.deleteMany({});
  console.log('✓ Distributors cleared.');

  await prisma.partner.deleteMany({});
  console.log('✓ Partners cleared.');

  await prisma.registeredLocation.deleteMany({});
  console.log('✓ Registered locations cleared.');

  // 4. Delete all wallets EXCEPT Super Admin's wallet
  await prisma.wallet.deleteMany({
    where: {
      userId: { not: superAdmin.id },
    },
  });

  // Ensure Super Admin has a clean zero-balance wallet
  let adminWallet = await prisma.wallet.findUnique({
    where: { userId: superAdmin.id },
  });

  if (!adminWallet) {
    adminWallet = await prisma.wallet.create({
      data: {
        userId: superAdmin.id,
        availableBalance: new Prisma.Decimal(0),
        reservedBalance: new Prisma.Decimal(0),
      },
    });
  } else {
    adminWallet = await prisma.wallet.update({
      where: { id: adminWallet.id },
      data: {
        availableBalance: new Prisma.Decimal(0),
        reservedBalance: new Prisma.Decimal(0),
      },
    });
  }
  console.log('✓ Wallets purged. Super Admin wallet balance reset to ₹0.00.');

  // 5. Delete all users EXCEPT Super Admin
  const deletedUsers = await prisma.user.deleteMany({
    where: {
      id: { not: superAdmin.id },
    },
  });
  console.log(`✓ Deleted ${deletedUsers.count} non-admin users. Only Super Admin remains.`);

  // 6. PlatformServices and SystemConfigs are preserved
  console.log('✓ System services and configurations preserved.');

  // 7. Verify final counts
  const finalUsers = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, status: true },
  });
  const finalTx = await prisma.walletTransaction.count();
  const finalBookings = await prisma.bookingRequest.count();
  const finalCentres = await prisma.centre.count();
  const finalDistributors = await prisma.distributor.count();
  const finalPartners = await prisma.partner.count();

  console.log('\n================ DATABASE PURGE COMPLETE ================');
  console.log('Users remaining in database:', finalUsers);
  console.log('Wallet transactions count  :', finalTx);
  console.log('Bookings count             :', finalBookings);
  console.log('Centres count              :', finalCentres);
  console.log('Distributors count         :', finalDistributors);
  console.log('Partners count             :', finalPartners);
  console.log('==========================================================\n');
  console.log('🔑 SUPER ADMIN LOGIN CREDENTIALS:');
  console.log(`   Email   : ${superAdmin.email}`);
  console.log(`   Password: Admin@123456`);
  console.log('==========================================================\n');
}

main()
  .catch((err) => {
    console.error('Purge error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
