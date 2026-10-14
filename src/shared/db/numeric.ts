import { Decimal } from 'decimal.js';
import type { Numeric } from './db.types.js';

export function toDecimal(value: Numeric): Decimal {
  return new Decimal(value.toString());
}