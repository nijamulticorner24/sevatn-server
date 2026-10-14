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

  // Super Admin
  await prisma.user.create({
    data: {
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

  // Default Worker Machine (PC-001) for local worker node
  await prisma.workerMachine.upsert({
    where: { machineCode: 'PC-001' },
    update: {
      machineToken: 'wkt_pc001_chennai_live_token_7728',
      status: WorkerStatus.ONLINE,
      active: true,
      lastHeartbeat: new Date(),
    },
    create: {
      machineCode: 'PC-001',
      machineName: 'Local Worker PC 1',
      machineToken: 'wkt_pc001_chennai_live_token_7728',
      status: WorkerStatus.ONLINE,
      active: true,
      version: '1.0.0',
      lastHeartbeat: new Date(),
    },
  });

  console.log('✅ Minimal seed done (including Worker PC-001)!');
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
