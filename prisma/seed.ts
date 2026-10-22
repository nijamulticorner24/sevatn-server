import {
  PrismaClient,
  Role,
  UserStatus,
  WorkerStatus,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Wiping database & applying minimal seed...');

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
  await prisma.user.create({
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

  // Demo Centre User
  const demoUser = await prisma.user.create({
    data: {
      name: 'Demo User',
      email: 'demo@gmail.com',
      mobile: '9876500000',
      passwordHash,
      role: Role.CENTRE,
      status: UserStatus.ACTIVE,
    },
  });

  // Wallet for Demo User
  await prisma.wallet.create({
    data: {
      userId: demoUser.id,
      availableBalance: 5000,
      reservedBalance: 0,
    },
  });

  console.log('✅ Minimal seed done (No pre-seeded workers — register via /admin/fleet)!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔑 Login Credentials (all use same password):');
  console.log('   Password : Admin@123456');
  console.log('   ─────────────────────────────────────────────');
  console.log('   Super Admin : superadmin@ticketassist.in');
  console.log('   Demo User   : demo@gmail.com');
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
