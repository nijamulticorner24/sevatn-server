-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'PAYMENT_SUBMITTED';

-- AlterTable
ALTER TABLE "BookingJob" ALTER COLUMN "leaseGeneration" SET DEFAULT 0;
ALTER TABLE "BookingJob" ADD COLUMN IF NOT EXISTS "paymentSubmittedAt" TIMESTAMP(3);

-- Backfill any null leaseGeneration to 0
UPDATE "BookingJob" SET "leaseGeneration" = 0 WHERE "leaseGeneration" IS NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BookingJob_workerId_leaseGeneration_idx" ON "BookingJob"("workerId", "leaseGeneration");
