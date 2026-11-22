import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class AuthorizePaymentDto {
  @IsInt()
  @Min(1)
  leaseGeneration: number;

  @IsString()
  @IsNotEmpty()
  fencingToken: string;
}
