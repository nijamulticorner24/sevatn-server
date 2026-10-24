import {
  IsString,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  MinLength,
  Matches,
} from 'class-validator';
import { PartnerStatus } from '@prisma/client';

export class CreatePartnerDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[6-9]\d{9}$/, { message: 'Mobile number must be a valid 10-digit Indian mobile number' })
  mobile: string;

  @IsString()
  @IsOptional()
  district?: string;

  @IsString()
  @IsOptional()
  taluk?: string;

  @IsString()
  @IsOptional()
  partnerCode?: string;

  @IsOptional()
  @IsEnum(PartnerStatus)
  status?: PartnerStatus;

  @IsOptional()
  commissionRate?: number;

  @IsOptional()
  commissionPercentage?: number;

  @IsString()
  @IsOptional()
  commissionSlab?: string;
}

export class UpdatePartnerDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  @Matches(/^[6-9]\d{9}$/, { message: 'Mobile number must be a valid 10-digit Indian mobile number' })
  mobile?: string;

  @IsString()
  @IsOptional()
  district?: string;

  @IsString()
  @IsOptional()
  taluk?: string;

  @IsOptional()
  @IsEnum(PartnerStatus)
  status?: PartnerStatus;

  @IsOptional()
  commissionRate?: number;

  @IsOptional()
  commissionPercentage?: number;

  @IsString()
  @IsOptional()
  commissionSlab?: string;

  @IsString()
  @IsOptional()
  @MinLength(6, { message: 'Password must be at least 6 characters long' })
  password?: string;
}

export class GenerateInvitationDto {
  @IsOptional()
  expiresInDays?: number;

  @IsOptional()
  expiresInMinutes?: number;

  @IsString()
  @IsOptional()
  shopName?: string;

  @IsString()
  @IsOptional()
  mobile?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  district?: string;

  @IsString()
  @IsOptional()
  taluk?: string;

  @IsOptional()
  metadata?: any;
}

export class SubmitPartnerPaymentDto {
  @IsString()
  @IsOptional()
  paymentMethod?: 'ONLINE' | 'OFFLINE';

  @IsString()
  @IsOptional()
  paymentReference?: string;

  @IsString()
  @IsOptional()
  gatewayPaymentId?: string;

  @IsString()
  @IsOptional()
  screenshotUrl?: string;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsString()
  @IsOptional()
  password?: string;
}

export class ApprovePartnerPaymentDto {
  @IsString()
  @IsOptional()
  notes?: string;
}

