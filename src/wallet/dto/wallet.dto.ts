import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class TopupDto {
  @IsNumber()
  @Min(100)
  amount: number;

  @IsOptional()
  @IsString()
  paymentReference?: string;

  @IsOptional()
  @IsString()
  paymentMethod?: 'ONLINE' | 'OFFLINE_QR';

  @IsOptional()
  @IsString()
  receiptUrl?: string;

  @IsOptional()
  @IsString()
  receiptFileName?: string;

  @IsOptional()
  @IsNumber()
  receiptFileSize?: number;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class ReserveFundsDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  bookingId: string;

  @IsNumber()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class CaptureFundsDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  bookingId: string;

  @IsNumber()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  workerMachineId?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class ReleaseFundsDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  bookingId: string;

  @IsNumber()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}

export class RequestRefundDto {
  @IsNumber()
  @Min(100)
  amount: number;

  @IsString()
  @IsNotEmpty()
  reason: string;

  @IsOptional()
  @IsString()
  upiId?: string;
}
