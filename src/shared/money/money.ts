import { Decimal } from 'decimal.js';
import { minorUnits } from './currency.js';

export const CAPACITY_SCALE = 4;

const DECIMAL_TEXT = /^(0|[1-9]\d{0,15})(\.\d{1,18})?$/;

export function isDecimalText(text: string): boolean {
  return DECIMAL_TEXT.test(text);
}

export function decimalPlaces(text: string): number {
  return text.split('.')[1]?.length ?? 0;
}

export function fitsMinorUnits(text: string, currency: string): boolean {
  return decimalPlaces(text) <= minorUnits(currency);
}

export function ceilTo(value: Decimal, places: number): Decimal {
  return value.toDecimalPlaces(places, Decimal.ROUND_CEIL);
}

export function exposure(
  outstanding: Decimal,
  rate: Decimal | undefined,
): Decimal {
  return rate ? ceilTo(outstanding.mul(rate), CAPACITY_SCALE) : outstanding;
}

export function formatAmount(value: Decimal, places: number): string {
  return value.toFixed(places);
}