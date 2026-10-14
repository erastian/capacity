import type { Decimal } from 'decimal.js';
import type { Numeric } from '../shared/db/db.types.js';

export type RateType = 'VALUATION' | 'CONVERSION';

export type RateStatus = 'ACTIVE' | 'SUSPENDED';

export interface QuoteRow {
  external_id: string;
  from_currency: string;
  to_currency: string;
  rate_type: RateType;
  version: Numeric;
  status: RateStatus;
  rate: Numeric | null;
  effective_as_of: Date;
}

export interface CurrentQuote {
  rateId: string;
  from: string;
  to: string;
  rateType: RateType;
  version: bigint;
  status: RateStatus;
  rate: Decimal | undefined;
  asOf: Date;
}

export interface QuoteView {
  rateId: string;
  from: string;
  to: string;
  rateType: RateType;
  version: string;
  status: RateStatus;
  rate: string | null;
  asOf: string;
}
