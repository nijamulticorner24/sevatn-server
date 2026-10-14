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
}

export class HeartbeatDto {
  @IsEnum(WorkerStatus)
  status: WorkerStatus;

  @IsOptional()
  @IsString()
  version?: string;

  @IsOptional()
  @IsString()
  currentJobId?: string;

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
