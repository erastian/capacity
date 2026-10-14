import { IsISO8601, IsString, Matches } from 'class-validator';
import { IDENTIFIER } from '../shared/domain/identifier.js';
import { IsCurrency } from '../shared/money/is-currency.js';
import { AMOUNT_TEXT } from '../shared/money/money.js';

export class ReserveRequest {
  @IsString()
  @Matches(IDENTIFIER, { message: 'programId must be 1-128 characters of [A-Za-z0-9._:/-]' })
  programId: string;

  @IsString()
  @Matches(IDENTIFIER, { message: 'invoiceId must be 1-128 characters of [A-Za-z0-9._:/-]' })
  invoiceId: string;

  @IsString()
  @Matches(AMOUNT_TEXT, {
    message: 'amount must be a positive decimal string',
  })
  amount: string;

  @IsCurrency()
  currency: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dueDate must be YYYY-MM-DD' })
  dueDate: string;
}

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,255}$/;
