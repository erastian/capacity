import { isCurrency, minorUnits } from './currency.js';
import {
  Decimal,
  exposure,
  fitsMinorUnits,
  formatAmount,
  isDecimalText,
} from './money.js';

describe('currencies', () => {
  it.each([
    ['EUR', 2],
    ['USD', 2],
    ['JPY', 0],
    ['KRW', 0],
    ['ISK', 0],
    ['KWD', 3],
    ['BHD', 3],
  ])('%s has %i minor units', (code, units) => {
    expect(minorUnits(code)).toBe(units);
  });

  it.each(['XAU', 'XTS', 'ABC', 'eur', ''])('rejects %s', (code) => {
    expect(isCurrency(code)).toBe(false);
  });
});

describe('amount text', () => {
  it.each(['0', '1', '100.5', '125000.00', '0.000012103412345678'])(
    'accepts %s',
    (text) => expect(isDecimalText(text)).toBe(true),
  );

  it.each(['', '-1', '+1', '01', '1.', '.5', '1e3', '1,5', ' 1', '12345678901234567'])(
    'rejects %s',
    (text) => expect(isDecimalText(text)).toBe(false),
  );

  it.each([
    ['100', 'JPY', true],
    ['100.5', 'JPY', false],
    ['10.01', 'USD', true],
    ['10.001', 'USD', false],
    ['10.001', 'KWD', true],
  ])('%s fits %s: %s', (text, currency, fits) => {
    expect(fitsMinorUnits(text, currency)).toBe(fits);
  });
});

describe('exposure', () => {
  it('equals outstanding without a rate', () => {
    expect(exposure(new Decimal('100.00'), undefined).toString()).toBe('100');
  });

  it('rounds up to four places in favour of risk', () => {
    expect(exposure(new Decimal('100.01'), new Decimal('0.333333')).toFixed(4)).toBe(
      '33.3367',
    );
  });

  it('is never zero while debt remains', () => {
    expect(
      exposure(new Decimal('1'), new Decimal('0.000012103412345678')).toFixed(4),
    ).toBe('0.0001');
  });

  it('formats with the requested places', () => {
    expect(formatAmount(new Decimal('100'), 2)).toBe('100.00');
  });
});