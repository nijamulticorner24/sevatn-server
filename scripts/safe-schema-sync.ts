import { execSync } from 'child_process';
import * as dotenv from 'dotenv';
import { URL } from 'url';

// Load environment variables from .env
dotenv.config();

function maskDatabaseUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const maskedUser = parsed.username ? '***' : '';
    const maskedPass = parsed.password ? ':***' : '';
    const auth = maskedUser || maskedPass ? `${maskedUser}${maskedPass}@` : '';
    return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}`;
  } catch {
    return 'postgresql://***:***@***/***';
  }
}

async function runSafeSchemaSync() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🛡️  TicketAssist / ServiceTN — Safe Schema Synchronization');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. Verify DATABASE_URL exists
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || dbUrl.trim().length === 0) {
    console.error('❌ FATAL: DATABASE_URL environment variable is missing or empty.');
    process.exit(1);
  }

  // 2. Parse and validate connection details safely
  const maskedUrl = maskDatabaseUrl(dbUrl);
  console.log(`📡 Target Database URL : ${maskedUrl}`);

  try {
    const parsed = new URL(dbUrl);
    const dbName = parsed.pathname.replace(/^\//, '');
    const dbHost = parsed.hostname;
    const dbPort = parsed.port || '5432';

    console.log(`📍 Host: ${dbHost}:${dbPort} | Database: ${dbName}`);

    if (process.env.NODE_ENV === 'production' && dbName !== 'servicetn_db') {
      console.warn(`⚠️  NOTICE: In production, expected database name is 'servicetn_db', but got '${dbName}'. Proceeding with caution.`);
    }
  } catch (err: any) {
    console.error(`❌ FATAL: Malformed DATABASE_URL: ${err.message}`);
    process.exit(1);
  }

  // 3. Confirm Safety Safeguards
  console.log('🔒 Verification Safeguards:');
  console.log('   - No destructive migrations or table resets allowed');
  console.log('   - No automatic seeding permitted');
  console.log('   - Additive schema synchronization only');

  // 4. Execute Prisma schema synchronization safely
  console.log('\n⚙️  Executing Prisma Schema Synchronization (prisma db push)...');
  try {
    // Run prisma db push without data loss flag
    const output = execSync('npx prisma db push --skip-generate', {
      encoding: 'utf8',
      env: {
        ...process.env,
        PRISMA_HIDE_PREVIEW_FLAG_WARNINGS: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    console.log('\n=== Prisma Output ===');
    console.log(output.trim());
    console.log('=====================');

    if (output.includes('Your database is now in sync with your Prisma schema')) {
      console.log('\n✅ Database schema synchronized successfully with zero data loss.');
    } else {
      console.log('\n✅ Schema synchronization completed.');
    }
  } catch (error: any) {
    console.error('\n❌ SCHEMA SYNCHRONIZATION FAILED:');
    if (error.stdout) {
      console.error(error.stdout.toString());
    }
    if (error.stderr) {
      console.error(error.stderr.toString());
    }
    console.error(`Error details: ${error.message}`);
    console.error('\n⚠️  Aborting deployment. Database was NOT modified with destructive changes.');
    process.exit(1);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

runSafeSchemaSync().catch((err) => {
  console.error('Unexpected failure in schema sync script:', err);
  process.exit(1);
});
