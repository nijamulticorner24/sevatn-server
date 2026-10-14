export class CreateAccountDto {
  label?: string;
  username: string;
  password: string;
}

export class VerifyAccountDto {
  label?: string;
  username: string;
  password: string;
}
