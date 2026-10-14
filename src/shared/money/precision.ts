import { Decimal } from 'decimal.js';

export const MONEY_PRECISION = 64;

Decimal.set({ precision: MONEY_PRECISION, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -9e15, toExpPos: 9e15 });
