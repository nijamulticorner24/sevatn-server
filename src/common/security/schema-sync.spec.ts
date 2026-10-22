import {
  maskDatabaseUrl,
  validateDatabaseUrl,
  splitSqlStatements,
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

  describe('splitSqlStatements', () => {
    it('splits multiple statements separated by semicolons', () => {
      const sql = 'CREATE TABLE "A" (id INT); CREATE TABLE "B" (id INT);';
      const statements = splitSqlStatements(sql);
      expect(statements).toHaveLength(2);
      expect(statements[0]).toBe('CREATE TABLE "A" (id INT)');
      expect(statements[1]).toBe('CREATE TABLE "B" (id INT)');
    });

    it('ignores semicolons inside single-quoted strings', () => {
      const sql = "ALTER TABLE \"T\" ADD COLUMN \"c\" TEXT DEFAULT 'a;b;c'; CREATE INDEX \"idx\" ON \"T\"(\"c\");";
      const statements = splitSqlStatements(sql);
      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain("'a;b;c'");
      expect(statements[1]).toBe('CREATE INDEX "idx" ON "T"("c")');
    });

    it('ignores semicolons inside comments', () => {
      const sql = `
        -- First comment with a semicolon;
        CREATE TABLE "X" (id INT);
        /* Block comment with ; and more */
        CREATE TABLE "Y" (id INT);
      `;
      const statements = splitSqlStatements(sql);
      expect(statements).toHaveLength(2);
    });
  });

  describe('classifySqlDiff — Fail-Closed Safety & Validation', () => {
    describe('Empty or partially classified diffs', () => {
      it('rejects an empty SQL diff as not safe (fail-closed)', () => {
        const res = classifySqlDiff('');
        expect(res.isAdditiveOnly).toBe(false);
        expect(res.totalStatements).toBe(0);
        expect(res.unapprovedOperations.length).toBeGreaterThan(0);
      });

      it('rejects a comment-only SQL diff as not safe', () => {
        const res = classifySqlDiff('   -- Clean diff with only comments\n   -- Nothing to run\n');
        expect(res.isAdditiveOnly).toBe(false);
        expect(res.totalStatements).toBe(0);
        expect(res.unapprovedOperations.length).toBeGreaterThan(0);
      });

      it('rejects partially classified diffs where 1 statement is unknown', () => {
        const sql = `
          CREATE TABLE "WorkerActivityLog" ("id" TEXT NOT NULL);
          VACUUM FULL "WorkerMachine";
        `;
        const res = classifySqlDiff(sql);
        expect(res.isAdditiveOnly).toBe(false);
        expect(res.additiveOperations).toHaveLength(1);
        expect(res.unapprovedOperations).toHaveLength(1);
        expect(res.unapprovedOperations[0]).toContain('VACUUM FULL');
      });

      it('rejects partially classified diffs where 1 statement is destructive', () => {
        const sql = `
          CREATE TABLE "WorkerActivityLog" ("id" TEXT NOT NULL);
          DROP TABLE "OldLog";
        `;
        const res = classifySqlDiff(sql);
        expect(res.isAdditiveOnly).toBe(false);
        expect(res.additiveOperations).toHaveLength(1);
        expect(res.destructiveOperations).toHaveLength(1);
        expect(res.destructiveOperations[0]).toContain('Drop Table');
      });
    });

    describe('Destructive SQL statement rejection', () => {
      it('detects and flags DROP TABLE as destructive', () => {
        const res = classifySqlDiff('DROP TABLE "LegacyWorker";');
        expect(res.isAdditiveOnly).toBe(false);
        expect(res.destructiveOperations[0]).toContain('Drop Table');
      });

      it('detects and flags DROP COLUMN as destructive', () => {
        const res = classifySqlDiff('ALTER TABLE "WorkerMachine" DROP COLUMN "machineToken";');
        expect(res.isAdditiveOnly).toBe(false);
        expect(res.destructiveOperations[0]).toContain('Drop Column');
      });

      it('detects and flags TRUNCATE, DROP TYPE, and DROP INDEX as destructive', () => {
        const res = classifySqlDiff('TRUNCATE TABLE "Bookings"; DROP TYPE "OldStatus"; DROP INDEX "idx_old";');
        expect(res.isAdditiveOnly).toBe(false);
        expect(res.destructiveOperations.length).toBe(3);
      });

      it('detects and flags ALTER COLUMN TYPE narrowing as destructive', () => {
        const res = classifySqlDiff('ALTER TABLE "WorkerMachine" ALTER COLUMN "version" TYPE VARCHAR(5);');
        expect(res.isAdditiveOnly).toBe(false);
        expect(res.destructiveOperations[0]).toContain('Alter Column Type');
      });

      it('detects and flags SET NOT NULL without default as destructive', () => {
        const res = classifySqlDiff('ALTER TABLE "WorkerMachine" ALTER COLUMN "version" SET NOT NULL;');
        expect(res.isAdditiveOnly).toBe(false);
        expect(res.destructiveOperations[0]).toContain('Set NOT NULL constraint');
      });

      it('detects and flags data mutations (DELETE / UPDATE / INSERT) as destructive', () => {
        const res = classifySqlDiff('DELETE FROM "WorkerMachine" WHERE id = \'1\'; UPDATE "User" SET role = \'ADMIN\';');
        expect(res.isAdditiveOnly).toBe(false);
        expect(res.destructiveOperations.length).toBe(2);
      });
    });

    describe('Unsafe Defaults & Constraints', () => {
      it('rejects ADD COLUMN with NOT NULL when no DEFAULT is specified (unsafe constraint)', () => {
        const res = classifySqlDiff('ALTER TABLE "WorkerMachine" ADD COLUMN "adminStatus" TEXT NOT NULL;');
        expect(res.isAdditiveOnly).toBe(false);
        expect(res.destructiveOperations.length).toBe(1);
        expect(res.destructiveOperations[0]).toMatch(/Unsafe Constraint \/ Default/i);
      });

      it('accepts ADD COLUMN with NOT NULL when a DEFAULT is explicitly provided', () => {
        const res = classifySqlDiff('ALTER TABLE "WorkerMachine" ADD COLUMN "adminStatus" TEXT NOT NULL DEFAULT \'ENABLED\';');
        expect(res.isAdditiveOnly).toBe(true);
        expect(res.destructiveOperations).toHaveLength(0);
        expect(res.summary.columnsAdded.length).toBe(1);
      });

      it('accepts ADD COLUMN when column is nullable (no NOT NULL)', () => {
        const res = classifySqlDiff('ALTER TABLE "WorkerMachine" ADD COLUMN "notes" TEXT;');
        expect(res.isAdditiveOnly).toBe(true);
        expect(res.destructiveOperations).toHaveLength(0);
        expect(res.summary.columnsAdded.length).toBe(1);
      });
    });

    describe('Quoted Identifiers & Complex Multi-Statement Batches', () => {
      it('correctly classifies genuine additive operations with double-quoted identifiers', () => {
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

          -- Step 5: Add Enum and Enum Value
          CREATE TYPE "WorkerTaskType" AS ENUM ('LOGIN', 'BOOKING');
          ALTER TYPE "WorkerTaskType" ADD VALUE 'CLEANUP';
        `;

        const res = classifySqlDiff(additiveSql);
        expect(res.isAdditiveOnly).toBe(true);
        expect(res.destructiveOperations).toHaveLength(0);
        expect(res.unapprovedOperations).toHaveLength(0);
        expect(res.summary.tablesCreated).toContain('WorkerActivityLog');
        expect(res.summary.columnsAdded.length).toBe(3);
        expect(res.summary.indexesCreated.length).toBe(1);
        expect(res.summary.foreignKeysAdded.length).toBe(1);
        expect(res.summary.enumsCreated).toContain('WorkerTaskType');
        expect(res.summary.enumValuesAdded.length).toBe(1);
      });

      it('correctly handles unquoted table and column identifiers', () => {
        const sql = 'ALTER TABLE WorkerMachine ADD COLUMN ipAddress TEXT; CREATE INDEX idx_worker ON WorkerMachine(ipAddress);';
        const res = classifySqlDiff(sql);
        expect(res.isAdditiveOnly).toBe(true);
        expect(res.summary.columnsAdded.length).toBe(1);
        expect(res.summary.indexesCreated.length).toBe(1);
      });

      it('rejects unknown or arbitrary SQL statements not explicitly approved', () => {
        const unknownSql = 'VACUUM FULL "WorkerMachine";';
        const res = classifySqlDiff(unknownSql);
        expect(res.isAdditiveOnly).toBe(false);
        expect(res.unapprovedOperations.length).toBe(1);
        expect(res.unapprovedOperations[0]).toContain('VACUUM FULL');
      });
    });
  });
});
