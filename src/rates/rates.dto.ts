import { IsIn, IsOptional, Matches } from 'class-validator';
import { PageQuery } from '../shared/http/pagination.js';
import type { RateType } from './rates.types.js';

const CURRENCY = /^[A-Z]{3}$/;

export class RatesQuery extends PageQuery {
  @IsOptional()
  @Matches(CURRENCY, { message: 'from must be an ISO 4217 code' })
  from?: string;

  @IsOptional()
  @Matches(CURRENCY, { message: 'to must be an ISO 4217 code' })
  to?: string;

  @IsOptional()
  @IsIn(['VALUATION', 'CONVERSION'])
  type?: RateType;
}