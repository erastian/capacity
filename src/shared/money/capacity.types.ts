import type { Decimal } from 'decimal.js';

export interface CapacityBalances {
  creditLimit: Decimal;
  externalUtilized: Decimal;
  reserved: Decimal;
}

export interface CapacityPosition {
  totalUtilized: Decimal;
  available: Decimal;
  overLimit: Decimal;
}
