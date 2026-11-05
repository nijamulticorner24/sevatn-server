import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class NomineeDto {
  @IsString()
  @IsNotEmpty({ message: 'Nominee name is required' })
  nomineeName: string;

  @IsInt({ message: 'Nominee age must be an integer' })
  @Min(18, { message: 'Nominee must be at least 18 years of age' })
  nomineeAge: number;

  @IsString()
  @IsNotEmpty({ message: 'Nominee relationship is required' })
  nomineeRelationship: string;

  @IsOptional()
  @IsString()
  nomineePhone?: string;
}

export class PilgrimDto {
  @IsString()
  @IsNotEmpty({ message: 'Pilgrim full name is required' })
  fullName: string;

  @IsInt({ message: 'Age must be an integer' })
  @Min(1, { message: 'Age must be at least 1' })
  age: number;

  @IsString()
  @IsNotEmpty({ message: 'Gender is required' })
  gender: string;

  @IsString()
  @IsNotEmpty({ message: 'ID type is required' })
  idType: string;

  @IsString()
  @IsNotEmpty({ message: 'ID number is required' })
  idNumber: string;

  @IsOptional()
  @IsString()
  photoUrl?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => NomineeDto)
  nominee?: NomineeDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NomineeDto)
  nominees?: NomineeDto[];

  @IsOptional()
  @IsString()
  nomineeName?: string;

  @IsOptional()
  @IsInt()
  nomineeAge?: number;

  @IsOptional()
  @IsString()
  nomineeRelationship?: string;

  @IsOptional()
  @IsString()
  nomineePhone?: string;
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
  @IsInt()
  @Min(1)
  pilgrimCount?: number;

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
  @ValidateNested()
  @Type(() => NomineeDto)
  nominee?: NomineeDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NomineeDto)
  nominees?: NomineeDto[];

  @IsOptional()
  @IsString()
  nomineeName?: string;

  @IsOptional()
  @IsInt()
  nomineeAge?: number;

  @IsOptional()
  @IsString()
  nomineeRelationship?: string;

  @IsOptional()
  @IsString()
  nomineePhone?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @IsBoolean()
  termsAccepted?: boolean;

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

export class ResolveHumanActionDto {
  @IsString()
  @IsNotEmpty()
  action: 'SUCCESS_CONFIRMED' | 'RETRY_QUEUE' | 'CANCEL';

  @IsOptional()
  @IsString()
  officialReference?: string;

  @IsOptional()
  @IsString()
  officialBookingReference?: string;

  @IsOptional()
  @IsString()
  cartId?: string;

  @IsOptional()
  @IsString()
  portalTransactionReference?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
