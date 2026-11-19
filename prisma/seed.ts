import {
  PrismaClient,
  Role,
  UserStatus,
  Prisma,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Applying clean database state (Only SUPER_ADMIN)...');

  // Wipe all existing table data
  try {
    const tablenames = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename != '_prisma_migrations';
    `;
    for (const { tablename } of tablenames) {
      try {
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE "public"."${tablename}" CASCADE;`);
      } catch (err: any) {
        console.warn(`Could not truncate ${tablename}:`, err.message);
      }
    }
    console.log('🧹 Database wiped.');
  } catch (err: any) {
    console.warn('Wipe warning (proceeding):', err.message);
  }

  const passwordHash = await bcrypt.hash('Admin@123456', 10);

  // Super Admin (fixed ID prevents token invalidation across dev re-seeds)
  const superAdmin = await prisma.user.create({
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

  // Wallet for Super Admin
  await prisma.wallet.create({
    data: {
      userId: superAdmin.id,
      availableBalance: new Prisma.Decimal(0),
      reservedBalance: new Prisma.Decimal(0),
    },
  });

  // Core Platform Services
  await prisma.platformService.createMany({
    data: [
      {
        code: 'TICKET_ASSIST',
        name: 'Sabarimala Virtual Q Booking Assistance',
        category: 'PILGRIMAGE',
        status: 'ACTIVE',
      },
      {
        code: 'INSTANT_SERVICE',
        name: 'Instant E-Governance Verification',
        category: 'GOVERNMENT',
        status: 'ACTIVE',
      },
    ],
  });

  // System Configuration Defaults
  await (prisma.systemConfig as any).create({
    data: {
      id: 'default',
      serviceFee: new Prisma.Decimal(10.0),
      registrationFee: new Prisma.Decimal(500.0),
      franchiseFee: new Prisma.Decimal(599.0),
      distributorFee: new Prisma.Decimal(2500.0),
      onlinePaymentEnabled: true,
      offlinePaymentEnabled: true,
      humanAssistedModeOnly: false,
    },
  });

  // Dynamic Pricing Architecture Default
  await (prisma.pricingConfig as any).create({
    data: {
      id: 'default',
      baseTicketPrice: new Prisma.Decimal(10.0),
      maxPartnerMarkup: new Prisma.Decimal(2.0),
      maxDistributorMarkup: new Prisma.Decimal(2.0),
      isActive: true,
      version: 1,
    },
  });

  console.log('✅ Clean database initialized with Super Admin ONLY!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔑 Login Credentials:');
  console.log('   Super Admin : superadmin@ticketassist.in');
  console.log('   Password    : Admin@123456');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((e) => {
    console.error('Seed error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
