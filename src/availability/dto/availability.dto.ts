import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class PublishAvailabilityDto {
  @IsString()
  @IsNotEmpty()
  date: string; // YYYY-MM-DD

  @IsString()
  @IsNotEmpty()
  route: string;

  @IsOptional()
  @IsString()
  timeSlot?: string;

  @IsOptional()
  @IsString()
  source?: string;
}

export class BulkPublishAvailabilityDto {
  @IsNotEmpty()
  opportunities: PublishAvailabilityDto[];
}

export class ClaimDemandDto {
  @IsString()
  @IsNotEmpty()
  demandKey: string;

  @IsString()
  @IsNotEmpty()
  workerId: string;
}

export class ReleaseDemandDto {
  @IsString()
  @IsNotEmpty()
  demandKey: string;

  @IsString()
  @IsNotEmpty()
  workerId: string;

  @IsString()
  @IsNotEmpty()
  status: 'AVAILABLE' | 'UNAVAILABLE' | 'ERROR';

  @IsOptional()
  durationMs?: number;

  @IsOptional()
  @IsString()
  errorMessage?: string;
}
