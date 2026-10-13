import { IsISO8601, IsString, Length, Matches } from 'class-validator';

const IDENTIFIER = /^[A-Za-z0-9._:/-]+$/;

export class ReserveRequest {
  @IsString()
  @Length(1, 128)
  @Matches(IDENTIFIER)
  programId: string;

  @IsString()
  @Length(1, 128)
  @Matches(IDENTIFIER)
  invoiceId: string;

  @IsString()
  @Matches(/^(0|[1-9]\d{0,15})(\.\d{1,4})?$/, {
    message: 'amount must be a positive decimal string',
  })
  amount: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dueDate must be YYYY-MM-DD' })
  dueDate: string;
}

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,255}$/;