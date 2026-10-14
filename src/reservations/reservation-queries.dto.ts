import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { IDENTIFIER } from '../shared/domain/identifier.js';
import { PageQuery } from '../shared/http/pagination.js';
import { IsCurrency } from '../shared/money/is-currency.js';
import type { ReservationStatus } from './reservation-views.types.js';

const STATUSES: ReservationStatus[] = ['ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED', 'CANCELLED'];

export class ReservationsQuery extends PageQuery {
  @IsOptional()
  @Matches(IDENTIFIER, { message: 'programId must be 1-128 characters of [A-Za-z0-9._:/-]' })
  programId?: string;

  @IsOptional()
  @Matches(IDENTIFIER, { message: 'invoiceId must be 1-128 characters of [A-Za-z0-9._:/-]' })
  invoiceId?: string;

  @IsOptional()
  @IsIn(STATUSES)
  status?: ReservationStatus;
}

export class PayoffQuoteQuery {
  @IsOptional()
  @IsCurrency()
  currency?: string;
}

export class DeclinesQuery extends PageQuery {
  @IsString()
  @Matches(IDENTIFIER, { message: 'invoiceId must be 1-128 characters of [A-Za-z0-9._:/-]' })
  invoiceId: string;
}
