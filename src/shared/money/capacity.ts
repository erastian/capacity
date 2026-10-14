import { Decimal } from 'decimal.js';
import type { CapacityBalances, CapacityPosition } from './capacity.types.js';
import './precision.js';

export function capacityOf(balances: CapacityBalances): CapacityPosition {
  const totalUtilized = balances.externalUtilized.plus(balances.reserved);
  const free = balances.creditLimit.minus(totalUtilized);
  return {
    totalUtilized,
    available: Decimal.max(free, 0),
    overLimit: Decimal.max(free.neg(), 0),
  };
}