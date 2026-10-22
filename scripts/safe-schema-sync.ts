import { execSync } from 'child_process';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { validateDatabaseUrl, classifySqlDiff } from './schema-validator';

// Load environment variables from .env
dotenv.config();

async function runSafeSchemaSync() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🛡️  TicketAssist / ServiceTN — Hardened Schema Synchronization');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run') || process.env.DRY_RUN === 'true';

  if (isDryRun) {
    console.log('🔍 Execution Mode: [DRY-RUN] (Validation & Preview Only - No Mutations)');
  } else {
    console.log('⚡ Execution Mode: [LIVE SYNCHRONIZATION]');
  }

  // 1. Validate DATABASE_URL with Strict Fail-Closed Security
  const rawDbUrl = process.env.DATABASE_URL;
  const validation = validateDatabaseUrl(rawDbUrl, {
    nodeEnv: process.env.NODE_ENV,
    expectedDbName: process.env.EXPECTED_DB_NAME || 'servicetn_db',
    expectedDbHost: process.env.EXPECTED_DB_HOST,
    allowCustomDbHost: process.env.ALLOW_CUSTOM_DB_HOST === 'true',
  });

  if (!validation.isValid) {
    console.error(`\n❌ FATAL SECURITY CHECK FAILED:`);
    console.error(`   ${validation.error}`);
    console.error(`   Connection String Target: ${validation.maskedUrl}`);
    console.error(`\n🛑 Halting deployment immediately. Database was NOT modified.`);
    process.exit(1);
  }

  console.log(`📡 Verified Target Database : ${validation.maskedUrl}`);
  console.log(`📍 Host: ${validation.dbHost}:${validation.dbPort} | Database: ${validation.dbName}`);
  console.log(`🏷️  Environment: ${process.env.NODE_ENV || 'development'}`);

  // 2. Locate schema file
  const schemaPath = path.resolve(__dirname, '../prisma/schema.prisma');
  if (!fs.existsSync(schemaPath)) {
    console.error(`❌ FATAL: Prisma schema not found at '${schemaPath}'.`);
    process.exit(1);
  }

  // 3. Generate Independent Schema Diff (Read-Only Comparison)
  console.log('\n🔎 Generating read-only schema diff against database catalog...');
  let sqlDiff = '';
  try {
    // Generate the exact SQL DDL migration script representing the difference
    sqlDiff = execSync(
      `npx prisma migrate diff --from-url "${rawDbUrl}" --to-schema-datamodel "${schemaPath}" --script`,
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PRISMA_HIDE_PREVIEW_FLAG_WARNINGS: 'true',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
  } catch (diffErr: any) {
    console.error('\n❌ FAILED TO GENERATE SCHEMA DIFF:');
    if (diffErr.stderr) {
      // Redact potential connection strings from stderr
      const safeStderr = diffErr.stderr.toString().replace(/postgresql:\/\/[^@]+@/g, 'postgresql://***:***@');
      console.error(safeStderr);
    }
    console.error(`Error details: ${diffErr.message}`);
    console.error('🛑 Halting deployment. Database was NOT modified.');
    process.exit(1);
  }

  const cleanDiff = sqlDiff.replace(/^--.*$/gm, '').trim();

  if (!cleanDiff) {
    console.log('\n✅ Database schema is ALREADY in sync with Prisma schema.');
    console.log('   Zero migrations or schema mutations required.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    process.exit(0);
  }

  // 4. Classify Proposed Schema Changes
  console.log('\n🔬 Classifying proposed schema changes...');
  const classification = classifySqlDiff(sqlDiff);

  if (!classification.isAdditiveOnly) {
    console.error('\n❌ DESTRUCTIVE SCHEMA CHANGES DETECTED:');
    console.error('   The proposed schema synchronization contains potentially destructive operations:');
    classification.destructiveOperations.forEach((op, idx) => {
      console.error(`   ${idx + 1}. ${op}`);
    });
    console.error('\n🛑 DEPLOYMENT ABORTED: Destructive operations (DROP TABLE/COLUMN, TYPE ALTERATION, etc.)');
    console.error('   are strictly forbidden in production. Manual database administrator review required.');
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    process.exit(1);
  }

  // 5. Output Verified Additive Change Summary
  console.log('\n📋 Verified Additive Changes to be Applied:');
  if (classification.summary.tablesCreated.length > 0) {
    console.log(`   ➕ Tables to Create (${classification.summary.tablesCreated.length}):`);
    classification.summary.tablesCreated.forEach((t) => console.log(`      - ${t}`));
  }
  if (classification.summary.columnsAdded.length > 0) {
    console.log(`   ➕ Columns to Add (${classification.summary.columnsAdded.length}):`);
    classification.summary.columnsAdded.forEach((c) => console.log(`      - ${c}`));
  }
  if (classification.summary.indexesCreated.length > 0) {
    console.log(`   ➕ Indexes to Create (${classification.summary.indexesCreated.length}):`);
    classification.summary.indexesCreated.forEach((i) => console.log(`      - ${i}`));
  }
  if (classification.summary.foreignKeysAdded.length > 0) {
    console.log(`   ➕ Foreign Keys to Add (${classification.summary.foreignKeysAdded.length}):`);
    classification.summary.foreignKeysAdded.forEach((f) => console.log(`      - ${f}`));
  }

  // 6. Dry-Run Completion
  if (isDryRun) {
    console.log('\n=== Proposed SQL DDL (Dry-Run Preview) ===');
    console.log(sqlDiff.trim());
    console.log('==========================================');
    console.log('\n✅ [DRY-RUN SUCCESS] All proposed changes are 100% additive and safe.');
    console.log('   No changes were applied to the database.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    process.exit(0);
  }

  // 7. Live Synchronization (Only reached if additive-only check passed)
  console.log('\n⚙️  Applying validated additive schema updates (prisma db push)...');
  try {
    const pushOutput = execSync('npx prisma db push --skip-generate', {
      encoding: 'utf8',
      env: {
        ...process.env,
        PRISMA_HIDE_PREVIEW_FLAG_WARNINGS: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    console.log('\n=== Prisma Engine Output ===');
    console.log(pushOutput.trim());
    console.log('============================');

    console.log('\n✅ Database schema synchronized successfully with zero data loss.');
  } catch (pushErr: any) {
    console.error('\n❌ SCHEMA SYNCHRONIZATION FAILED DURING EXECUTION:');
    if (pushErr.stdout) console.error(pushErr.stdout.toString());
    if (pushErr.stderr) {
      const safeStderr = pushErr.stderr.toString().replace(/postgresql:\/\/[^@]+@/g, 'postgresql://***:***@');
      console.error(safeStderr);
    }
    console.error(`Error details: ${pushErr.message}`);
    console.error('\n🛑 Halting deployment.');
    process.exit(1);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

runSafeSchemaSync().catch((err) => {
  console.error('Unexpected failure in safe schema sync script:', err);
  process.exit(1);
});
