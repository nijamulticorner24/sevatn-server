-- AlterTable WorkerMachine
ALTER TABLE "WorkerMachine" ADD COLUMN IF NOT EXISTS "maxMonitoringRequests" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "WorkerMachine" ADD COLUMN IF NOT EXISTS "currentAssignedMonitoring" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkerMachine" ADD COLUMN IF NOT EXISTS "monitoringDraining" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WorkerMachine" ADD COLUMN IF NOT EXISTS "browserContextCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorkerMachine" ADD COLUMN IF NOT EXISTS "resourceWarning" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex on WorkerMachine
CREATE INDEX IF NOT EXISTS "WorkerMachine_maxMonitoringRequests_currentAssignedMonitoring_idx" ON "WorkerMachine"("maxMonitoringRequests", "currentAssignedMonitoring");

-- AlterTable BookingRequest
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "assignedMonitoringWorkerId" TEXT;
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "isManuallyAssigned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "monitoringAssignedAt" TIMESTAMP(3);
ALTER TABLE "BookingRequest" ADD COLUMN IF NOT EXISTS "monitoringLeaseExpiresAt" TIMESTAMP(3);

-- AddForeignKey on BookingRequest
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BookingRequest_assignedMonitoringWorkerId_fkey'
  ) THEN
    ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_assignedMonitoringWorkerId_fkey"
      FOREIGN KEY ("assignedMonitoringWorkerId") REFERENCES "WorkerMachine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- CreateIndex on BookingRequest
CREATE INDEX IF NOT EXISTS "BookingRequest_assignedMonitoringWorkerId_status_idx" ON "BookingRequest"("assignedMonitoringWorkerId", "status");
CREATE INDEX IF NOT EXISTS "BookingRequest_status_isManuallyAssigned_requestedDateStr_idx" ON "BookingRequest"("status", "isManuallyAssigned", "requestedDateStr");
