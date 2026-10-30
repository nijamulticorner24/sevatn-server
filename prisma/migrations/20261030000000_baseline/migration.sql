-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'CENTRE', 'WORKER', 'PARTNER');

-- CreateEnum
CREATE TYPE "PartnerStatus" AS ENUM ('PENDING_PAYMENT', 'PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('ACTIVE', 'USED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('REGISTERED', 'PAYMENT_PENDING', 'ACTIVE', 'EXPIRING', 'EXPIRED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "CentreStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'EXPIRED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('UNVERIFIED', 'VERIFYING', 'VERIFIED', 'INVALID', 'REQUIRES_HUMAN', 'DISABLED');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('ACCOUNT_VERIFICATION', 'BOOKING_EXECUTION', 'AVAILABILITY_DISCOVERY');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('NEW', 'AVAILABILITY_CHECKING', 'DRAFT', 'PENDING', 'SUBMITTED', 'QUEUED', 'FAST_BOOKING_QUEUED', 'MATCHING', 'CLAIMED', 'EXECUTION_QUEUED', 'EXECUTING', 'WAITING_FOR_ACCOUNT', 'WORKER_ASSIGNED', 'ASSIGNED', 'BROWSER_STARTING', 'OFFICIAL_SITE_OPEN', 'OPENING_OFFICIAL_SITE', 'LOGIN_IN_PROGRESS', 'LOGIN_SUCCESS', 'LOGIN_FAILED', 'BOOKING_FLOW_STARTED', 'OPENING_VIRTUAL_Q', 'WAITING_FOR_DATE_AVAILABILITY', 'DATE_AVAILABLE', 'SELECTING_DATE', 'VERIFYING_DATE_SELECTION', 'DATE_SELECTION_VERIFIED', 'DATE_SELECTION_FAILED', 'DATE_VERIFICATION_FAILED', 'DATE_AVAILABILITY_TIMEOUT', 'SELECTING_ROUTE', 'OPENING_PILGRIM_SELECTION', 'SELECTING_EXISTING_PILGRIMS', 'SUBMITTING_PILGRIMS', 'SELECTING_RELIEF_FUND_NO', 'ADDING_TO_WISHLIST', 'VERIFYING_RESULT', 'WISHLIST_ADDED', 'CHECKING_AVAILABILITY', 'WATCHING', 'WAITING', 'AVAILABILITY_FOUND', 'BOOKING_IN_PROGRESS', 'BOOKING', 'CONFIRMATION_CHECK', 'BOOKING_CONFIRMED', 'SUCCESS', 'COMPLETED', 'TEMPORARY_SLOT_LOST', 'NO_AVAILABILITY', 'DATE_UNAVAILABLE', 'ROUTE_UNAVAILABLE', 'PILGRIM_SELECTION_FAILED', 'SUBMIT_FAILED', 'SITE_ERROR', 'CAPTCHA_REQUIRED', 'OTP_REQUIRED', 'WORKER_ERROR', 'TIMEOUT', 'FAILED', 'SITE_UNAVAILABLE', 'UNKNOWN', 'UNKNOWN_RESULT', 'UNKNOWN_OUTCOME', 'CANCELLED', 'EXPIRED', 'REQUIRES_HUMAN');

-- CreateEnum
CREATE TYPE "WorkerStatus" AS ENUM ('UNPAIRED', 'ONLINE', 'OFFLINE', 'BUSY', 'IDLE', 'ERROR', 'MAINTENANCE', 'UPDATING', 'STOPPED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('TOPUP', 'RESERVE', 'CAPTURE', 'RELEASE', 'REFUND', 'ADJUSTMENT', 'SETTLEMENT');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PROCESSED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'SETTLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FinancialStatus" AS ENUM ('NOT_RESERVED', 'RESERVED', 'CAPTURED', 'RELEASED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('IDLE', 'ASSIGNED', 'CLAIMED', 'RUNNING', 'SUBMISSION_PENDING', 'COMPLETED', 'FAILED', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "LedgerAccount" AS ENUM ('CENTRE_AVAILABLE', 'CENTRE_RESERVED', 'YUKTRON_REVENUE', 'WORKER_INCENTIVE', 'REFUND_ESCROW');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('DEBIT', 'CREDIT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'CENTRE',
    "status" "UserStatus" NOT NULL DEFAULT 'REGISTERED',
    "registrationDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "partnerId" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Centre" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "centreName" TEXT NOT NULL,
    "centreCode" TEXT,
    "address" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "taluk" TEXT NOT NULL,
    "pincode" TEXT,
    "registrationFee" DECIMAL(65,30) NOT NULL DEFAULT 249.00,
    "feePaid" BOOLEAN NOT NULL DEFAULT false,
    "feeTransactionId" TEXT,
    "paymentProofUrl" TEXT,
    "status" "CentreStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Centre_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT,
    "username" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,
    "encryptionIv" TEXT NOT NULL,
    "encryptionTag" TEXT NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "lastVerifiedAt" TIMESTAMP(3),
    "verificationNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "availableBalance" DECIMAL(65,30) NOT NULL DEFAULT 0.00,
    "reservedBalance" DECIMAL(65,30) NOT NULL DEFAULT 0.00,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTransaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bookingId" TEXT,
    "type" "TransactionType" NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "yuktronShare" DECIMAL(65,30) DEFAULT 0.00,
    "workerShare" DECIMAL(65,30) DEFAULT 0.00,
    "status" "TransactionStatus" NOT NULL DEFAULT 'COMPLETED',
    "reference" TEXT,
    "idempotencyKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingRequest" (
    "id" TEXT NOT NULL,
    "bookingCode" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT,
    "requestedDate" TIMESTAMP(3) NOT NULL,
    "requestedDateStr" TEXT,
    "route" TEXT NOT NULL,
    "pilgrimCount" INTEGER NOT NULL DEFAULT 1,
    "timeSlot" TEXT,
    "selectedTime" TEXT,
    "preferences" JSONB,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "financialStatus" "FinancialStatus" NOT NULL DEFAULT 'NOT_RESERVED',
    "executionStatus" "ExecutionStatus" NOT NULL DEFAULT 'IDLE',
    "reconciliationStatus" TEXT,
    "lastMilestone" TEXT,
    "assignedMachineId" TEXT,
    "leaseStartedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "checkCount" INTEGER NOT NULL DEFAULT 0,
    "officialReference" TEXT,
    "confirmationData" JSONB,
    "failureReason" TEXT,
    "requiresHumanNote" TEXT,
    "matchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "nomineeName" TEXT,
    "nomineeAge" INTEGER,
    "nomineeRelationship" TEXT,
    "nomineePhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingJob" (
    "id" TEXT NOT NULL,
    "jobType" "JobType" NOT NULL DEFAULT 'BOOKING_EXECUTION',
    "bookingRequestId" TEXT,
    "accountId" TEXT,
    "workerId" TEXT,
    "status" "BookingStatus" NOT NULL DEFAULT 'QUEUED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "leaseGeneration" INTEGER NOT NULL DEFAULT 1,
    "leaseId" TEXT,
    "fencingToken" TEXT,
    "lastMilestone" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingPilgrim" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "age" INTEGER NOT NULL,
    "gender" TEXT NOT NULL,
    "idType" TEXT NOT NULL,
    "idNumber" TEXT NOT NULL,
    "photoUrl" TEXT,
    "metadata" JSONB,
    "nomineeName" TEXT,
    "nomineeAge" INTEGER,
    "nomineeRelationship" TEXT,
    "nomineePhone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingPilgrim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerMachine" (
    "id" TEXT NOT NULL,
    "machineCode" TEXT NOT NULL,
    "machineName" TEXT NOT NULL,
    "pairingCode" TEXT,
    "machineToken" TEXT,
    "status" "WorkerStatus" NOT NULL DEFAULT 'UNPAIRED',
    "adminStatus" TEXT NOT NULL DEFAULT 'ENABLED',
    "desiredState" TEXT NOT NULL DEFAULT 'STOPPED',
    "currentActivity" TEXT,
    "activityDetails" TEXT,
    "activityStartedAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "currentBookingId" TEXT,
    "retirementReason" TEXT,
    "retiredAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "ipAddress" TEXT,
    "lastHeartbeat" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT false,
    "currentJobId" TEXT,
    "cpuUsage" DOUBLE PRECISION DEFAULT 0,
    "memoryUsage" DOUBLE PRECISION DEFAULT 0,
    "jobsCompleted" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "operatorShareBalance" DECIMAL(65,30) NOT NULL DEFAULT 0.00,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deploymentType" TEXT NOT NULL DEFAULT 'LOCAL_PC',
    "installationId" TEXT,
    "maxConcurrentJobs" INTEGER NOT NULL DEFAULT 1,
    "currentActiveJobs" INTEGER NOT NULL DEFAULT 0,
    "capabilities" TEXT[] DEFAULT ARRAY['ACCOUNT_VERIFICATION', 'BOOKING_EXECUTION', 'AVAILABILITY_DISCOVERY']::TEXT[],
    "lastJobAt" TIMESTAMP(3),

    CONSTRAINT "WorkerMachine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerActivityLog" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "jobId" TEXT,
    "bookingId" TEXT,
    "eventType" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "activity" TEXT,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobAllocationLog" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "bookingId" TEXT,
    "workerId" TEXT,
    "status" TEXT NOT NULL,
    "decisionReason" TEXT NOT NULL,
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "evaluatedWorkers" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobAllocationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingAttempt" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT,
    "jobId" TEXT,
    "machineId" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "status" "BookingStatus" NOT NULL,
    "officialState" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "resultReference" TEXT,
    "executionLogs" JSONB,
    "screenshotUrl" TEXT,

    CONSTRAINT "BookingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "reason" TEXT NOT NULL,
    "upiId" TEXT,
    "proofUrl" TEXT,
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "reference" TEXT,
    "adminNotes" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "recipient" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "responsePayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "serviceFee" DECIMAL(65,30) NOT NULL DEFAULT 100.00,
    "yuktronShare" DECIMAL(65,30) NOT NULL DEFAULT 80.00,
    "workerShare" DECIMAL(65,30) NOT NULL DEFAULT 20.00,
    "registrationFee" DECIMAL(65,30) NOT NULL DEFAULT 249.00,
    "franchiseFee" DECIMAL(65,30) NOT NULL DEFAULT 599.00,
    "accountValidityDays" INTEGER NOT NULL DEFAULT 365,
    "checkingIntervalSeconds" INTEGER NOT NULL DEFAULT 300,
    "leaseTimeoutSeconds" INTEGER NOT NULL DEFAULT 120,
    "humanAssistedModeOnly" BOOLEAN NOT NULL DEFAULT false,
    "partnerMinWithdrawal" DECIMAL(65,30) NOT NULL DEFAULT 100.00,
    "onlinePaymentEnabled" BOOLEAN NOT NULL DEFAULT true,
    "onlineGatewayProvider" TEXT NOT NULL DEFAULT 'RAZORPAY',
    "onlineGatewayKeyId" TEXT,
    "onlineGatewayKeySecret" TEXT,
    "offlinePaymentEnabled" BOOLEAN NOT NULL DEFAULT true,
    "offlineUpiId" TEXT NOT NULL DEFAULT 'pay.ticketassist@okaxis',
    "offlineAccountName" TEXT NOT NULL DEFAULT 'TicketAssist Services & Network',
    "offlineQrImageUrl" TEXT,
    "offlineBankName" TEXT DEFAULT 'HDFC Bank',
    "offlineAccountNumber" TEXT DEFAULT '50200012345678',
    "offlineIfscCode" TEXT DEFAULT 'HDFC0001234',
    "offlinePaymentInstructions" TEXT DEFAULT 'Scan the official QR code or pay via UPI. Enter your 12-digit UTR/Reference ID for instant validation.',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilityOpportunity" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "timeSlot" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "source" TEXT NOT NULL DEFAULT 'official-portal',
    "idempotencyKey" TEXT NOT NULL,
    "matchedBookingId" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvailabilityOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountLock" (
    "accountId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "workerId" TEXT,
    "leaseGeneration" INTEGER NOT NULL DEFAULT 1,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountLock_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "Partner" (
    "id" TEXT NOT NULL,
    "partnerCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "district" TEXT,
    "taluk" TEXT,
    "status" "PartnerStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "franchiseFee" DECIMAL(65,30) NOT NULL DEFAULT 599.00,
    "feePaid" BOOLEAN NOT NULL DEFAULT false,
    "paymentReference" TEXT,
    "paymentProofUrl" TEXT,
    "userId" TEXT,
    "balance" DECIMAL(65,30) NOT NULL DEFAULT 0.00,
    "commissionRate" DECIMAL(65,30) NOT NULL DEFAULT 20.00,
    "commissionPercentage" DECIMAL(65,30) NOT NULL DEFAULT 20.00,
    "commissionSlab" TEXT DEFAULT 'STANDARD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerPayout" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "upiId" TEXT NOT NULL,
    "accountHolder" TEXT,
    "status" "PayoutStatus" NOT NULL DEFAULT 'REQUESTED',
    "paymentReference" TEXT,
    "screenshotUrl" TEXT,
    "adminNotes" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerInvitation" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "usedByUserId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegisteredLocation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "address" TEXT,
    "district" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegisteredLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformService" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstantServiceQuery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "applicationNumber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "responseData" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstantServiceQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingMilestone" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "milestone" TEXT NOT NULL,
    "attemptId" INTEGER NOT NULL DEFAULT 1,
    "workerId" TEXT,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletLedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bookingId" TEXT,
    "transactionId" TEXT,
    "account" "LedgerAccount" NOT NULL,
    "entryType" "LedgerEntryType" NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "idempotencyKey" TEXT,
    "reference" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingReconciliation" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lastMilestone" TEXT,
    "investigationNote" TEXT,
    "resolvedReference" TEXT,
    "resolvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "BookingReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_mobile_key" ON "User"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_mobile_idx" ON "User"("mobile");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_status_idx" ON "User"("role", "status");

-- CreateIndex
CREATE INDEX "User_partnerId_idx" ON "User"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "Centre_userId_key" ON "Centre"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Centre_centreCode_key" ON "Centre"("centreCode");

-- CreateIndex
CREATE INDEX "Centre_district_idx" ON "Centre"("district");

-- CreateIndex
CREATE INDEX "Centre_status_idx" ON "Centre"("status");

-- CreateIndex
CREATE INDEX "BookingAccount_userId_status_idx" ON "BookingAccount"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BookingAccount_userId_username_key" ON "BookingAccount"("userId", "username");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE INDEX "Wallet_userId_idx" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_idempotencyKey_key" ON "WalletTransaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WalletTransaction_userId_type_idx" ON "WalletTransaction"("userId", "type");

-- CreateIndex
CREATE INDEX "WalletTransaction_bookingId_idx" ON "WalletTransaction"("bookingId");

-- CreateIndex
CREATE INDEX "WalletTransaction_createdAt_idx" ON "WalletTransaction"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_bookingCode_key" ON "BookingRequest"("bookingCode");

-- CreateIndex
CREATE INDEX "BookingRequest_userId_status_idx" ON "BookingRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "BookingRequest_status_nextCheckAt_idx" ON "BookingRequest"("status", "nextCheckAt");

-- CreateIndex
CREATE INDEX "BookingRequest_assignedMachineId_idx" ON "BookingRequest"("assignedMachineId");

-- CreateIndex
CREATE INDEX "BookingRequest_requestedDate_route_idx" ON "BookingRequest"("requestedDate", "route");

-- CreateIndex
CREATE INDEX "BookingRequest_requestedDate_status_createdAt_idx" ON "BookingRequest"("requestedDate", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BookingRequest_requestedDate_route_status_createdAt_idx" ON "BookingRequest"("requestedDate", "route", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BookingRequest_accountId_status_idx" ON "BookingRequest"("accountId", "status");

-- CreateIndex
CREATE INDEX "BookingJob_status_leaseExpiresAt_idx" ON "BookingJob"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "BookingJob_workerId_idx" ON "BookingJob"("workerId");

-- CreateIndex
CREATE INDEX "BookingJob_bookingRequestId_idx" ON "BookingJob"("bookingRequestId");

-- CreateIndex
CREATE INDEX "BookingJob_accountId_idx" ON "BookingJob"("accountId");

-- CreateIndex
CREATE INDEX "BookingPilgrim_bookingRequestId_idx" ON "BookingPilgrim"("bookingRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerMachine_machineCode_key" ON "WorkerMachine"("machineCode");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerMachine_pairingCode_key" ON "WorkerMachine"("pairingCode");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerMachine_machineToken_key" ON "WorkerMachine"("machineToken");

-- CreateIndex
CREATE INDEX "WorkerMachine_status_idx" ON "WorkerMachine"("status");

-- CreateIndex
CREATE INDEX "WorkerMachine_active_idx" ON "WorkerMachine"("active");

-- CreateIndex
CREATE INDEX "WorkerMachine_adminStatus_idx" ON "WorkerMachine"("adminStatus");

-- CreateIndex
CREATE INDEX "WorkerMachine_machineCode_idx" ON "WorkerMachine"("machineCode");

-- CreateIndex
CREATE INDEX "WorkerMachine_deploymentType_idx" ON "WorkerMachine"("deploymentType");

-- CreateIndex
CREATE INDEX "WorkerActivityLog_workerId_timestamp_idx" ON "WorkerActivityLog"("workerId", "timestamp");

-- CreateIndex
CREATE INDEX "WorkerActivityLog_jobId_idx" ON "WorkerActivityLog"("jobId");

-- CreateIndex
CREATE INDEX "WorkerActivityLog_eventType_idx" ON "WorkerActivityLog"("eventType");

-- CreateIndex
CREATE INDEX "WorkerActivityLog_severity_idx" ON "WorkerActivityLog"("severity");

-- CreateIndex
CREATE INDEX "WorkerActivityLog_timestamp_idx" ON "WorkerActivityLog"("timestamp");

-- CreateIndex
CREATE INDEX "JobAllocationLog_jobId_idx" ON "JobAllocationLog"("jobId");

-- CreateIndex
CREATE INDEX "JobAllocationLog_bookingId_idx" ON "JobAllocationLog"("bookingId");

-- CreateIndex
CREATE INDEX "JobAllocationLog_workerId_idx" ON "JobAllocationLog"("workerId");

-- CreateIndex
CREATE INDEX "JobAllocationLog_status_idx" ON "JobAllocationLog"("status");

-- CreateIndex
CREATE INDEX "JobAllocationLog_createdAt_idx" ON "JobAllocationLog"("createdAt");

-- CreateIndex
CREATE INDEX "BookingAttempt_bookingId_idx" ON "BookingAttempt"("bookingId");

-- CreateIndex
CREATE INDEX "BookingAttempt_jobId_idx" ON "BookingAttempt"("jobId");

-- CreateIndex
CREATE INDEX "BookingAttempt_machineId_idx" ON "BookingAttempt"("machineId");

-- CreateIndex
CREATE INDEX "RefundRequest_userId_status_idx" ON "RefundRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "NotificationEvent_userId_idx" ON "NotificationEvent"("userId");

-- CreateIndex
CREATE INDEX "NotificationEvent_status_idx" ON "NotificationEvent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_key_key" ON "IdempotencyRecord"("key");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_key_idx" ON "IdempotencyRecord"("key");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AvailabilityOpportunity_idempotencyKey_key" ON "AvailabilityOpportunity"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AvailabilityOpportunity_date_route_status_idx" ON "AvailabilityOpportunity"("date", "route", "status");

-- CreateIndex
CREATE INDEX "AvailabilityOpportunity_detectedAt_idx" ON "AvailabilityOpportunity"("detectedAt");

-- CreateIndex
CREATE INDEX "AccountLock_expiresAt_idx" ON "AccountLock"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_partnerCode_key" ON "Partner"("partnerCode");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_userId_key" ON "Partner"("userId");

-- CreateIndex
CREATE INDEX "Partner_status_idx" ON "Partner"("status");

-- CreateIndex
CREATE INDEX "Partner_partnerCode_idx" ON "Partner"("partnerCode");

-- CreateIndex
CREATE INDEX "PartnerPayout_partnerId_idx" ON "PartnerPayout"("partnerId");

-- CreateIndex
CREATE INDEX "PartnerPayout_status_idx" ON "PartnerPayout"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerInvitation_token_key" ON "PartnerInvitation"("token");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerInvitation_usedByUserId_key" ON "PartnerInvitation"("usedByUserId");

-- CreateIndex
CREATE INDEX "PartnerInvitation_token_idx" ON "PartnerInvitation"("token");

-- CreateIndex
CREATE INDEX "PartnerInvitation_partnerId_status_idx" ON "PartnerInvitation"("partnerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RegisteredLocation_userId_key" ON "RegisteredLocation"("userId");

-- CreateIndex
CREATE INDEX "RegisteredLocation_userId_idx" ON "RegisteredLocation"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformService_code_key" ON "PlatformService"("code");

-- CreateIndex
CREATE INDEX "PlatformService_code_idx" ON "PlatformService"("code");

-- CreateIndex
CREATE INDEX "PlatformService_status_idx" ON "PlatformService"("status");

-- CreateIndex
CREATE INDEX "InstantServiceQuery_userId_createdAt_idx" ON "InstantServiceQuery"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "InstantServiceQuery_applicationNumber_idx" ON "InstantServiceQuery"("applicationNumber");

-- CreateIndex
CREATE INDEX "BookingMilestone_bookingRequestId_timestamp_idx" ON "BookingMilestone"("bookingRequestId", "timestamp");

-- CreateIndex
CREATE INDEX "BookingMilestone_milestone_idx" ON "BookingMilestone"("milestone");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_createdAt_idx" ON "OutboxEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_idx" ON "OutboxEvent"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_walletId_createdAt_idx" ON "WalletLedgerEntry"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_bookingId_idx" ON "WalletLedgerEntry"("bookingId");

-- CreateIndex
CREATE INDEX "WalletLedgerEntry_idempotencyKey_idx" ON "WalletLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "BookingReconciliation_bookingRequestId_key" ON "BookingReconciliation"("bookingRequestId");

-- CreateIndex
CREATE INDEX "BookingReconciliation_status_idx" ON "BookingReconciliation"("status");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Centre" ADD CONSTRAINT "Centre_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAccount" ADD CONSTRAINT "BookingAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "BookingRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BookingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_assignedMachineId_fkey" FOREIGN KEY ("assignedMachineId") REFERENCES "WorkerMachine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingJob" ADD CONSTRAINT "BookingJob_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingJob" ADD CONSTRAINT "BookingJob_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BookingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingJob" ADD CONSTRAINT "BookingJob_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "WorkerMachine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPilgrim" ADD CONSTRAINT "BookingPilgrim_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerActivityLog" ADD CONSTRAINT "WorkerActivityLog_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "WorkerMachine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAllocationLog" ADD CONSTRAINT "JobAllocationLog_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "WorkerMachine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAttempt" ADD CONSTRAINT "BookingAttempt_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAttempt" ADD CONSTRAINT "BookingAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BookingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAttempt" ADD CONSTRAINT "BookingAttempt_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "WorkerMachine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationEvent" ADD CONSTRAINT "NotificationEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Partner" ADD CONSTRAINT "Partner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerPayout" ADD CONSTRAINT "PartnerPayout_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerInvitation" ADD CONSTRAINT "PartnerInvitation_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerInvitation" ADD CONSTRAINT "PartnerInvitation_usedByUserId_fkey" FOREIGN KEY ("usedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegisteredLocation" ADD CONSTRAINT "RegisteredLocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstantServiceQuery" ADD CONSTRAINT "InstantServiceQuery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingMilestone" ADD CONSTRAINT "BookingMilestone_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletLedgerEntry" ADD CONSTRAINT "WalletLedgerEntry_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "BookingRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingReconciliation" ADD CONSTRAINT "BookingReconciliation_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

