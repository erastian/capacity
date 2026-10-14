import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { PageQuery } from '../shared/http/pagination.js';
import type { ReservationStatus } from './reservation-views.types.js';

const IDENTIFIER = /^[A-Za-z0-9._:/-]+$/;
const STATUSES: ReservationStatus[] = ['ACTIVE', 'PARTIALLY_RELEASED', 'RELEASED', 'CANCELLED'];

export class ReservationsQuery extends PageQuery {
  @IsOptional()
  @Length(1, 128)
  @Matches(IDENTIFIER)
  programId?: string;

  @IsOptional()
  @Length(1, 128)
  @Matches(IDENTIFIER)
  invoiceId?: string;

  @IsOptional()
  @IsIn(STATUSES)
  status?: ReservationStatus;
}

export class PayoffQuoteQuery {
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code' })
  currency?: string;
}

export class DeclinesQuery extends PageQuery {
  @IsString()
  @Length(1, 128)
  @Matches(IDENTIFIER)
  invoiceId: string;
}