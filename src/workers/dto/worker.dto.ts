import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsArray,
  Min,
  Max,
} from 'class-validator';
import { WorkerStatus, BookingStatus } from '@prisma/client';

export class RegisterMachineDto {
  @IsString()
  @IsNotEmpty()
  machineCode: string; // e.g. PC-001

  @IsString()
  @IsNotEmpty()
  machineName: string;

  @IsOptional()
  @IsString()
  version?: string;
}

export class PairMachineDto {
  @IsString()
  @IsNotEmpty()
  pairingCode: string;

  @IsOptional()
  @IsString()
  machineCode?: string;

  @IsOptional()
  @IsString()
  machineName?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class CreateWorkerDto {
  @IsString()
  @IsNotEmpty()
  machineCode: string; // e.g. PC-002

  @IsString()
  @IsNotEmpty()
  machineName: string; // e.g. "Chennai Terminal 02"

  @IsOptional()
  @IsString()
  version?: string;

  @IsOptional()
  @IsString()
  assignedCentreId?: string;
}

export class AdminWorkerActionDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class HeartbeatDto {
  @IsString()
  @IsNotEmpty()
  status: string;

  @IsOptional()
  @IsString()
  version?: string;

  @IsOptional()
  @IsString()
  currentJobId?: string;

  @IsOptional()
  @IsString()
  currentBookingId?: string;

  @IsOptional()
  @IsString()
  currentActivity?: string;

  @IsOptional()
  @IsString()
  activityDetails?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  activeJobIds?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  cpuUsage?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  memoryUsage?: number;

  @IsOptional()
  @IsString()
  deploymentType?: string; // LOCAL_PC | CLOUD_VM | DOCKER

  @IsOptional()
  @IsString()
  installationId?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  maxConcurrentJobs?: number;
}

export class UpdateWorkerCapacityDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(20)
  maxConcurrentJobs?: number;

  @IsOptional()
  @IsString()
  deploymentType?: string; // LOCAL_PC | CLOUD_VM | DOCKER

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  capabilities?: string[];

  @IsOptional()
  @IsString()
  adminStatus?: string;
}

export class AllocationQueryDto {
  @IsOptional()
  @IsString()
  workerId?: string;

  @IsOptional()
  @IsString()
  jobId?: string;

  @IsOptional()
  @IsString()
  bookingId?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  limit?: any;

  @IsOptional()
  offset?: any;
}

export class ActivityLogQueryDto {
  @IsOptional()
  @IsString()
  workerId?: string;

  @IsOptional()
  @IsString()
  jobId?: string;

  @IsOptional()
  @IsString()
  bookingId?: string;

  @IsOptional()
  @IsString()
  eventType?: string;

  @IsOptional()
  @IsString()
  severity?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  limit?: any;

  @IsOptional()
  offset?: any;
}

export class UpdateJobStatusDto {
  @IsEnum(BookingStatus)
  status: BookingStatus;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  requiresHumanNote?: string;

  @IsOptional()
  executionLogs?: any;
}

export class ReportJobResultDto {
  @IsEnum(BookingStatus)
  status: BookingStatus; // SUCCESS, FAILED, UNKNOWN, REQUIRES_HUMAN

  @IsOptional()
  @IsString()
  officialReference?: string;

  @IsOptional()
  confirmationData?: any;

  @IsOptional()
  @IsString()
  failureReason?: string;

  @IsOptional()
  executionLogs?: any;

  @IsOptional()
  @IsString()
  screenshotUrl?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
