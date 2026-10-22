import {
  maskDatabaseUrl,
  validateDatabaseUrl,
  classifySqlDiff,
} from '../../../scripts/schema-validator';

describe('Schema Validator & Production Sync Hardening', () => {
  describe('maskDatabaseUrl', () => {
    it('masks password and username in PostgreSQL connection URLs', () => {
      const raw = 'postgresql://admin_user:SuperSecretPassword123@prod-db.c123.ap-south-1.rds.amazonaws.com:5432/servicetn_db?schema=public';
      const masked = maskDatabaseUrl(raw);
      expect(masked).not.toContain('SuperSecretPassword123');
      expect(masked).not.toContain('admin_user');
      expect(masked).toBe('postgresql://***:***@prod-db.c123.ap-south-1.rds.amazonaws.com:5432/servicetn_db');
    });

    it('handles invalid or empty inputs safely without throwing', () => {
      expect(maskDatabaseUrl('')).toBe('postgresql://***:***@***/***');
      expect(maskDatabaseUrl(undefined as any)).toBe('postgresql://***:***@***/***');
      expect(maskDatabaseUrl('not-a-valid-url')).toBe('postgresql://***:***@***/***');
    });
  });

  describe('validateDatabaseUrl', () => {
    it('fails closed when DATABASE_URL is missing or empty', () => {
      const res = validateDatabaseUrl('');
      expect(res.isValid).toBe(false);
      expect(res.error).toMatch(/missing or empty/i);
    });

    it('fails closed on malformed connection string', () => {
      const res = validateDatabaseUrl('http://[invalid-url');
      expect(res.isValid).toBe(false);
      expect(res.error).toMatch(/malformed/i);
    });

    it('fails closed on invalid protocol (e.g. mysql: or mongodb:)', () => {
      const res = validateDatabaseUrl('mysql://user:pass@host:3306/db');
      expect(res.isValid).toBe(false);
      expect(res.error).toMatch(/invalid protocol/i);
    });

    it('fails closed in production if database name is not servicetn_db', () => {
      const res = validateDatabaseUrl(
        'postgresql://user:pass@my-rds.c123.rds.amazonaws.com:5432/wrong_db',
        { nodeEnv: 'production', expectedDbName: 'servicetn_db' },
      );
      expect(res.isValid).toBe(false);
      expect(res.error).toMatch(/database name mismatch/i);
      expect(res.error).toContain('servicetn_db');
      expect(res.error).toContain('wrong_db');
    });

    it('fails closed in production if host is localhost or 127.0.0.1', () => {
      const res = validateDatabaseUrl(
        'postgresql://user:pass@localhost:5432/servicetn_db',
        { nodeEnv: 'production' },
      );
      expect(res.isValid).toBe(false);
      expect(res.error).toMatch(/cannot target localhost/i);
    });

    it('fails closed in production if host is not an AWS RDS endpoint and no custom host allowed', () => {
      const res = validateDatabaseUrl(
        'postgresql://user:pass@random-vps-server.net:5432/servicetn_db',
        { nodeEnv: 'production' },
      );
      expect(res.isValid).toBe(false);
      expect(res.error).toMatch(/not a recognized AWS RDS endpoint/i);
    });

    it('succeeds in production with valid AWS RDS host and servicetn_db database', () => {
      const res = validateDatabaseUrl(
        'postgresql://user:pass@servicetn-prod.c12345.ap-south-1.rds.amazonaws.com:5432/servicetn_db',
        { nodeEnv: 'production', expectedDbName: 'servicetn_db' },
      );
      expect(res.isValid).toBe(true);
      expect(res.dbName).toBe('servicetn_db');
      expect(res.dbHost).toBe('servicetn-prod.c12345.ap-south-1.rds.amazonaws.com');
    });

    it('enforces exact EXPECTED_DB_HOST matching when specified', () => {
      const validHost = 'servicetn-prod.c12345.ap-south-1.rds.amazonaws.com';
      const resOk = validateDatabaseUrl(
        `postgresql://user:pass@${validHost}:5432/servicetn_db`,
        { nodeEnv: 'production', expectedDbHost: validHost },
      );
      expect(resOk.isValid).toBe(true);

      const resFail = validateDatabaseUrl(
        'postgresql://user:pass@different-host.rds.amazonaws.com:5432/servicetn_db',
        { nodeEnv: 'production', expectedDbHost: validHost },
      );
      expect(resFail.isValid).toBe(false);
      expect(resFail.error).toMatch(/host mismatch/i);
    });
  });

  describe('classifySqlDiff', () => {
    it('detects and flags DROP TABLE as destructive', () => {
      const sql = 'DROP TABLE "LegacyWorker";';
      const res = classifySqlDiff(sql);
      expect(res.isAdditiveOnly).toBe(false);
      expect(res.destructiveOperations.length).toBe(1);
      expect(res.destructiveOperations[0]).toContain('Drop Table');
    });

    it('detects and flags DROP COLUMN as destructive', () => {
      const sql = 'ALTER TABLE "WorkerMachine" DROP COLUMN "machineToken";';
      const res = classifySqlDiff(sql);
      expect(res.isAdditiveOnly).toBe(false);
      expect(res.destructiveOperations.length).toBe(1);
      expect(res.destructiveOperations[0]).toContain('Drop Column');
    });

    it('detects and flags TRUNCATE and DROP TYPE as destructive', () => {
      const sql = 'TRUNCATE TABLE "Bookings"; DROP TYPE "OldStatus";';
      const res = classifySqlDiff(sql);
      expect(res.isAdditiveOnly).toBe(false);
      expect(res.destructiveOperations.length).toBe(2);
    });

    it('detects and flags ALTER COLUMN TYPE narrowing as destructive', () => {
      const sql = 'ALTER TABLE "WorkerMachine" ALTER COLUMN "version" TYPE VARCHAR(5);';
      const res = classifySqlDiff(sql);
      expect(res.isAdditiveOnly).toBe(false);
      expect(res.destructiveOperations.length).toBe(1);
    });

    it('correctly classifies genuine additive operations as additive-only', () => {
      const additiveSql = `
        -- Step 1: Add lifecycle columns to WorkerMachine
        ALTER TABLE "WorkerMachine" ADD COLUMN "adminStatus" TEXT NOT NULL DEFAULT 'ENABLED';
        ALTER TABLE "WorkerMachine" ADD COLUMN "currentActivity" TEXT;
        ALTER TABLE "WorkerMachine" ADD COLUMN "maxConcurrentJobs" INTEGER NOT NULL DEFAULT 1;

        -- Step 2: Create new log tables
        CREATE TABLE "WorkerActivityLog" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "workerId" TEXT NOT NULL,
          "eventType" TEXT NOT NULL,
          "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        -- Step 3: Add index
        CREATE INDEX "WorkerMachine_adminStatus_idx" ON "WorkerMachine"("adminStatus");

        -- Step 4: Add foreign key constraint
        ALTER TABLE "WorkerActivityLog" ADD CONSTRAINT "WorkerActivityLog_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "WorkerMachine"("id") ON DELETE CASCADE;
      `;

      const res = classifySqlDiff(additiveSql);
      expect(res.isAdditiveOnly).toBe(true);
      expect(res.destructiveOperations).toHaveLength(0);
      expect(res.summary.tablesCreated).toContain('WorkerActivityLog');
      expect(res.summary.columnsAdded.length).toBe(3);
      expect(res.summary.indexesCreated.length).toBe(1);
      expect(res.summary.foreignKeysAdded.length).toBe(1);
    });

    it('handles empty diff as additive-only with zero changes', () => {
      const res = classifySqlDiff('   -- Clean diff with only comments\n   ');
      expect(res.isAdditiveOnly).toBe(true);
      expect(res.destructiveOperations).toHaveLength(0);
      expect(res.additiveOperations).toHaveLength(0);
    });
  });
});
