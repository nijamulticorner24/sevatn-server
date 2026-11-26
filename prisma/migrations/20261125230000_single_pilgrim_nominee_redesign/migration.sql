-- Migration: 20261125230000_single_pilgrim_nominee_redesign
-- Purpose: Additive support for 1-Saved-Pilgrim + 1-Nominee Booking Model, Saved Pilgrim Identity Fingerprinting, and BookingConfirmationHistory Duplicate Prevention
-- Safety: 100% Additive. Zero dropped tables, columns, or constraints. Safe for all existing production data.

-- 1. Add PENDING_VERIFICATION to BookingStatus enum if not exists
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'PENDING_VERIFICATION';

-- 2. AlterTable BookingRequest: Add nominee validation milestone and selected saved pilgrim tracking columns
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "nomineeValidationStatus" TEXT DEFAULT 'RECEIVED';
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "selectedSavedPilgrimId" TEXT;
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "selectedPilgrimFingerprint" TEXT;
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "selectedPilgrimName" TEXT;

-- 3. CreateTable: AccountSavedPilgrim
CREATE TABLE IF NOT EXISTS "AccountSavedPilgrim" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "portalPilgrimId" TEXT,
    "identityFingerprint" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "age" INTEGER,
    "gender" TEXT,
    "idType" TEXT,
    "maskedIdNumber" TEXT,
    "lastSelectedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountSavedPilgrim_pkey" PRIMARY KEY ("id")
);

-- 4. CreateTable: BookingConfirmationHistory
CREATE TABLE IF NOT EXISTS "BookingConfirmationHistory" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "savedPilgrimId" TEXT,
    "selectedPilgrimFingerprint" TEXT,
    "selectedPilgrimName" TEXT,
    "requestedDateStr" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "selectedSlot" TEXT,
    "nomineeName" TEXT,
    "nomineeAge" INTEGER,
    "nomineeRelationship" TEXT,
    "nomineePhone" TEXT,
    "officialBookingReference" TEXT NOT NULL,
    "cartId" TEXT,
    "portalTransactionReference" TEXT,
    "officialReceiptReference" TEXT,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingConfirmationHistory_pkey" PRIMARY KEY ("id")
);

-- 5. Foreign Keys & Unique Constraints (Idempotent DO blocks)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE c.conname = 'AccountSavedPilgrim_accountId_fkey'
          AND t.relname = 'AccountSavedPilgrim'
          AND n.nspname = CURRENT_SCHEMA()
    ) THEN
        ALTER TABLE "AccountSavedPilgrim" ADD CONSTRAINT "AccountSavedPilgrim_accountId_fkey"
            FOREIGN KEY ("accountId") REFERENCES "BookingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE c.conname = 'BookingConfirmationHistory_bookingRequestId_fkey'
          AND t.relname = 'BookingConfirmationHistory'
          AND n.nspname = CURRENT_SCHEMA()
    ) THEN
        ALTER TABLE "BookingConfirmationHistory" ADD CONSTRAINT "BookingConfirmationHistory_bookingRequestId_fkey"
            FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE c.conname = 'BookingConfirmationHistory_accountId_fkey'
          AND t.relname = 'BookingConfirmationHistory'
          AND n.nspname = CURRENT_SCHEMA()
    ) THEN
        ALTER TABLE "BookingConfirmationHistory" ADD CONSTRAINT "BookingConfirmationHistory_accountId_fkey"
            FOREIGN KEY ("accountId") REFERENCES "BookingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE c.conname = 'BookingConfirmationHistory_savedPilgrimId_fkey'
          AND t.relname = 'BookingConfirmationHistory'
          AND n.nspname = CURRENT_SCHEMA()
    ) THEN
        ALTER TABLE "BookingConfirmationHistory" ADD CONSTRAINT "BookingConfirmationHistory_savedPilgrimId_fkey"
            FOREIGN KEY ("savedPilgrimId") REFERENCES "AccountSavedPilgrim"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- 6. Unique Indexes & Performance Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "AccountSavedPilgrim_accountId_identityFingerprint_key" ON "AccountSavedPilgrim"("accountId", "identityFingerprint");
CREATE INDEX IF NOT EXISTS "AccountSavedPilgrim_accountId_idx" ON "AccountSavedPilgrim"("accountId");
CREATE INDEX IF NOT EXISTS "AccountSavedPilgrim_identityFingerprint_idx" ON "AccountSavedPilgrim"("identityFingerprint");

CREATE UNIQUE INDEX IF NOT EXISTS "BookingConfirmationHistory_bookingRequestId_key" ON "BookingConfirmationHistory"("bookingRequestId");
CREATE UNIQUE INDEX IF NOT EXISTS "BookingConfirmationHistory_officialBookingReference_key" ON "BookingConfirmationHistory"("officialBookingReference");
CREATE INDEX IF NOT EXISTS "BookingConfirmationHistory_accountId_requestedDateStr_idx" ON "BookingConfirmationHistory"("accountId", "requestedDateStr");
CREATE INDEX IF NOT EXISTS "BookingConfirmationHistory_selectedPilgrimFingerprint_reque_idx" ON "BookingConfirmationHistory"("selectedPilgrimFingerprint", "requestedDateStr");
CREATE INDEX IF NOT EXISTS "BookingConfirmationHistory_requestedDateStr_route_idx" ON "BookingConfirmationHistory"("requestedDateStr", "route");

-- 7. Backfill Historical Confirmed Bookings into BookingConfirmationHistory (Non-destructive, Idempotent)
INSERT INTO "BookingConfirmationHistory" (
    "id",
    "bookingRequestId",
    "accountId",
    "requestedDateStr",
    "route",
    "selectedSlot",
    "nomineeName",
    "nomineeAge",
    "nomineeRelationship",
    "nomineePhone",
    "officialBookingReference",
    "cartId",
    "portalTransactionReference",
    "officialReceiptReference",
    "confirmedAt",
    "createdAt"
)
SELECT
    "id",
    "id" AS "bookingRequestId",
    "accountId",
    COALESCE("requestedDateStr", TO_CHAR("requestedDate", 'YYYY-MM-DD')) AS "requestedDateStr",
    "route",
    "selectedTime",
    "nomineeName",
    "nomineeAge",
    "nomineeRelationship",
    "nomineePhone",
    COALESCE("officialBookingReference", "officialReference") AS "officialBookingReference",
    "cartId",
    "portalTransactionReference",
    "officialReceiptReference",
    COALESCE("confirmedAt", "completedAt", "updatedAt") AS "confirmedAt",
    "createdAt"
FROM "BookingRequest"
WHERE "accountId" IS NOT NULL
  AND "status" IN ('SUCCESS', 'COMPLETED', 'BOOKING_CONFIRMED')
  AND COALESCE("officialBookingReference", "officialReference") IS NOT NULL
  AND LENGTH(TRIM(COALESCE("officialBookingReference", "officialReference"))) >= 5
  AND COALESCE("officialBookingReference", "officialReference") NOT LIKE 'SAB-2026-%'
ON CONFLICT DO NOTHING;
