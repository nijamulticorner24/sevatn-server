-- CreateTable
CREATE TABLE "DiscoverySchedule" (
    "demandKey" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "lastCheckedAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "lockExpiresAt" TIMESTAMP(3),
    "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoverySchedule_pkey" PRIMARY KEY ("demandKey")
);

-- CreateIndex
CREATE INDEX "DiscoverySchedule_nextCheckAt_idx" ON "DiscoverySchedule"("nextCheckAt");

-- CreateIndex
CREATE INDEX "DiscoverySchedule_lockExpiresAt_idx" ON "DiscoverySchedule"("lockExpiresAt");

