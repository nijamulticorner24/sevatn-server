-- Migration: 20261125200000_add_monitoring_telemetry
-- Purpose: Persistent Monitoring Telemetry, Auditing Counters, and MonitoringPollEvent Table
-- Safety: 100% Additive. No dropped columns, tables, or indexes. Safe for existing production data.

-- 1. AlterTable WorkerMachine: Add monitoring telemetry & lifecycle stop auditing columns
ALTER TABLE "WorkerMachine" ADD COLUMN IF NOT EXISTS "totalRefreshCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkerMachine" ADD COLUMN IF NOT EXISTS "totalRequestsMonitored" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkerMachine" ADD COLUMN IF NOT EXISTS "totalSuccessfulRefreshes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkerMachine" ADD COLUMN IF NOT EXISTS "totalFullResults" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkerMachine" ADD COLUMN IF NOT EXISTS "totalAvailableResults" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkerMachine" ADD COLUMN IF NOT EXISTS "totalUnknownResults" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkerMachine" ADD COLUMN IF NOT EXISTS "totalApiErrors" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkerMachine" ADD COLUMN IF NOT EXISTS "lastRefreshAt" TIMESTAMP(3);
ALTER TABLE "WorkerMachine" ADD COLUMN IF NOT EXISTS "stopReason" TEXT;
ALTER TABLE "WorkerMachine" ADD COLUMN IF NOT EXISTS "stoppedAt" TIMESTAMP(3);

-- 2. AlterTable BookingRequest: Add monitoring refresh & sequence auditing columns
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "totalRefreshCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "lastPollSequence" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "lastRefreshAt" TIMESTAMP(3);
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "lastSuccessfulRefreshAt" TIMESTAMP(3);
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "lastRefreshResult" TEXT;
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "lastError" TEXT;
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "monitoringStartedAt" TIMESTAMP(3);
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "monitoringStoppedAt" TIMESTAMP(3);

-- 3. CreateTable: MonitoringPollEvent
CREATE TABLE IF NOT EXISTS "MonitoringPollEvent" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "bookingRequestId" TEXT,
    "workerSessionId" TEXT NOT NULL DEFAULT 'default',
    "demandKey" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "pollSequence" INTEGER NOT NULL,
    "pollStartedAt" TIMESTAMP(3) NOT NULL,
    "pollDurationMs" INTEGER NOT NULL DEFAULT 0,
    "resultState" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitoringPollEvent_pkey" PRIMARY KEY ("id")
);

-- 4. Foreign Keys for MonitoringPollEvent (scoped to table and schema)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE c.conname = 'MonitoringPollEvent_workerId_fkey'
          AND t.relname = 'MonitoringPollEvent'
          AND n.nspname = CURRENT_SCHEMA()
    ) THEN
        ALTER TABLE "MonitoringPollEvent" ADD CONSTRAINT "MonitoringPollEvent_workerId_fkey"
            FOREIGN KEY ("workerId") REFERENCES "WorkerMachine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE c.conname = 'MonitoringPollEvent_bookingRequestId_fkey'
          AND t.relname = 'MonitoringPollEvent'
          AND n.nspname = CURRENT_SCHEMA()
    ) THEN
        ALTER TABLE "MonitoringPollEvent" ADD CONSTRAINT "MonitoringPollEvent_bookingRequestId_fkey"
            FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- 5. Unique Constraint: (workerId, workerSessionId, demandKey, pollSequence)
-- Constraint name: 'MonitoringPollEvent_workerId_workerSessionId_demandKey_poll_key' (exactly 63 bytes)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE c.conname = 'MonitoringPollEvent_workerId_workerSessionId_demandKey_poll_key'
          AND t.relname = 'MonitoringPollEvent'
          AND n.nspname = CURRENT_SCHEMA()
    ) AND NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE c.relname = 'MonitoringPollEvent_workerId_workerSessionId_demandKey_poll_key'
          AND n.nspname = CURRENT_SCHEMA()
    ) THEN
        ALTER TABLE "MonitoringPollEvent" ADD CONSTRAINT "MonitoringPollEvent_workerId_workerSessionId_demandKey_poll_key"
            UNIQUE ("workerId", "workerSessionId", "demandKey", "pollSequence");
    END IF;
END $$;

-- 6. Indexes for MonitoringPollEvent
CREATE INDEX IF NOT EXISTS "MonitoringPollEvent_workerId_createdAt_idx" ON "MonitoringPollEvent"("workerId", "createdAt");
CREATE INDEX IF NOT EXISTS "MonitoringPollEvent_bookingRequestId_createdAt_idx" ON "MonitoringPollEvent"("bookingRequestId", "createdAt");
CREATE INDEX IF NOT EXISTS "MonitoringPollEvent_demandKey_createdAt_idx" ON "MonitoringPollEvent"("demandKey", "createdAt");
CREATE INDEX IF NOT EXISTS "MonitoringPollEvent_workerId_workerSessionId_idx" ON "MonitoringPollEvent"("workerId", "workerSessionId");
