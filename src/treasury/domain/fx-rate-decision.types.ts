import type { Decimal } from 'decimal.js';
import type { FxRateStatus, FxRateType } from '../adapter/commands.types.js';

export interface StoredQuote {
  rateId: string;
  from: string;
  to: string;
  rateType: FxRateType;
  version: bigint;
  status: FxRateStatus;
  rate?: Decimal;
}

export type FxRatePlan = { outcome: 'APPLIED' } | { outcome: 'STALE' } | { outcome: 'REJECTED'; reason: 'FX_RATE_CONFLICT'; conflictsWith: string };
