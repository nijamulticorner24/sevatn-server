import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PilgrimDto {
  @IsString()
  @IsNotEmpty()
  fullName: string;

  @IsInt()
  @Min(1)
  age: number;

  @IsString()
  @IsNotEmpty()
  gender: string;

  @IsString()
  @IsNotEmpty()
  idType: string;

  @IsString()
  @IsNotEmpty()
  idNumber: string;

  @IsOptional()
  @IsString()
  photoUrl?: string;
}

export class CreateBookingDto {
  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsString()
  accountLabel?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsDateString()
  requestedDate: string;

  @IsString()
  @IsNotEmpty()
  route: string; // e.g. Pamba (Regular Footpath Route)

  @IsOptional()
  @IsString()
  timeSlot?: string;

  @IsOptional()
  preferences?: Record<string, any>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PilgrimDto)
  pilgrims?: PilgrimDto[];

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @IsBoolean()
  termsAccepted?: boolean;
}

export class ResolveHumanActionDto {
  @IsString()
  @IsNotEmpty()
  action: 'SUCCESS_CONFIRMED' | 'RETRY_QUEUE' | 'CANCEL';

  @IsOptional()
  @IsString()
  officialReference?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
