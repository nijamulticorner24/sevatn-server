import { IsNumber, IsOptional, IsBoolean, Min, Max } from 'class-validator';

export class UpdatePricingConfigDto {
  @IsNumber()
  @Min(0, { message: 'Base ticket price cannot be negative' })
  baseTicketPrice: number;

  @IsNumber()
  @Min(0, { message: 'Maximum Partner markup cannot be negative' })
  maxPartnerMarkup: number;

  @IsNumber()
  @Min(0, { message: 'Maximum Distributor markup cannot be negative' })
  maxDistributorMarkup: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateMarkupDto {
  @IsNumber()
  @Min(0, { message: 'Markup cannot be negative' })
  markup: number;
}

