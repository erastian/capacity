import { Decimal } from 'decimal.js';

export const MONEY_PRECISION = 64;

Decimal.set({ precision: MONEY_PRECISION, rounding: Decimal.ROUND_HALF_UP });