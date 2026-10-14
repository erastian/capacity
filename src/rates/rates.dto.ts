import { IsIn, IsOptional } from 'class-validator';
import { PageQuery } from '../shared/http/pagination.js';
import { IsCurrency } from '../shared/money/is-currency.js';
import type { RateType } from './rates.types.js';

export class RatesQuery extends PageQuery {
  @IsOptional()
  @IsCurrency()
  from?: string;

  @IsOptional()
  @IsCurrency()
  to?: string;

  @IsOptional()
  @IsIn(['VALUATION', 'CONVERSION'])
  type?: RateType;
}