import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class PublishAvailabilityDto {
  @IsString()
  @IsNotEmpty()
  date: string; // YYYY-MM-DD

  @IsString()
  @IsNotEmpty()
  route: string;

  @IsString()
  @IsNotEmpty()
  timeSlot: string;

  @IsOptional()
  @IsString()
  source?: string;
}

export class BulkPublishAvailabilityDto {
  @IsNotEmpty()
  opportunities: PublishAvailabilityDto[];
}
