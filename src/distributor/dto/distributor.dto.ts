import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  Matches,
  MinLength,
  IsNumber,
  Min,
  IsIn,
} from 'class-validator';

export class CreateDistributorDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsOptional()
  businessName?: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[6-9]\d{9}$/, { message: 'Mobile number must be a valid 10-digit Indian mobile number' })
  mobile: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  district?: string;

  @IsString()
  @IsOptional()
  taluk?: string;

  @IsString()
  @IsOptional()
  commissionSlab?: string;

  @IsNumber()
  @IsOptional()
  commissionPercentage?: number;

  @IsNumber()
  @IsOptional()
  commissionRate?: number;

  @IsNumber()
  @IsOptional()
  @Min(0, { message: 'Markup cannot be negative' })
  markup?: number;

  @IsString()
  @IsOptional()
  @MinLength(6, { message: 'Password must be at least 6 characters' })
  password?: string;
}

export class UpdateDistributorDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  businessName?: string;

  @IsString()
  @IsOptional()
  @Matches(/^[6-9]\d{9}$/, { message: 'Mobile number must be a valid 10-digit Indian mobile number' })
  mobile?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  district?: string;

  @IsString()
  @IsOptional()
  taluk?: string;

  @IsString()
  @IsOptional()
  commissionSlab?: string;

  @IsNumber()
  @IsOptional()
  commissionPercentage?: number;

  @IsNumber()
  @IsOptional()
  commissionRate?: number;

  @IsNumber()
  @IsOptional()
  @Min(0, { message: 'Markup cannot be negative' })
  markup?: number;

  @IsString()
  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE', 'SUSPENDED'])
  status?: string;

  @IsString()
  @IsOptional()
  @MinLength(6, { message: 'Password must be at least 6 characters' })
  password?: string;
}

export class UpdateDistributorStatusDto {
  @IsString()
  @IsIn(['ACTIVE', 'INACTIVE', 'SUSPENDED'])
  status: string;

  @IsString()
  @IsOptional()
  reason?: string;
}

export class GenerateCentreInvitationDto {
  @IsOptional()
  @IsNumber()
  expiresInMinutes?: number;

  @IsOptional()
  metadata?: any;
}

