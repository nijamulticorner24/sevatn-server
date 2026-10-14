import { IsEmail, IsNotEmpty, IsOptional, IsString, IsNumber, MinLength, IsEnum } from 'class-validator';
import { CentreStatus } from '@prisma/client';

export class CreateCentreDto {
  @IsString()
  @IsNotEmpty()
  centreName: string;

  @IsString()
  @IsNotEmpty()
  name: string; // Operator / Owner Full Name

  @IsString()
  @IsNotEmpty()
  mobile: string;

  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  district: string;

  @IsString()
  @IsNotEmpty()
  taluk: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  pincode?: string;

  @IsOptional()
  @IsString()
  centreCode?: string;

  @IsOptional()
  @IsEnum(CentreStatus)
  status?: CentreStatus;

  @IsOptional()
  @IsNumber()
  validityDays?: number;

  @IsOptional()
  @IsString()
  expiryDate?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  temporaryPassword?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsNumber()
  accuracy?: number;
}

export class UpdateCentreDto {
  @IsOptional()
  @IsString()
  centreName?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  mobile?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  district?: string;

  @IsOptional()
  @IsString()
  taluk?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  pincode?: string;

  @IsOptional()
  @IsString()
  centreCode?: string;

  @IsOptional()
  @IsEnum(CentreStatus)
  status?: CentreStatus;

  @IsOptional()
  @IsString()
  expiryDate?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsNumber()
  accuracy?: number;
}
