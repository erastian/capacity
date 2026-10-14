import { isCurrency, minorUnits } from './currency.js';
import { Decimal } from 'decimal.js';
import { AMOUNT_TEXT, exposure, fitsMinorUnits, formatAmount, RATE_TEXT } from './money.js';

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

describe('amount and rate text', () => {
  it.each(['0', '1', '100.5', '125000.00', '1.0001'])('accepts the amount %s', (text) => expect(AMOUNT_TEXT.test(text)).toBe(true));

  it.each(['', '-1', '+1', '01', '1.', '.5', '1e3', '1,5', ' 1', '12345678901234567', '1.00001'])('rejects the amount %s', (text) =>
    expect(AMOUNT_TEXT.test(text)).toBe(false),
  );

  it.each(['0.000012103412345678', '12345678901234567890'])('accepts the rate %s', (text) => expect(RATE_TEXT.test(text)).toBe(true));

  it.each(['0.0000121034123456789', '123456789012345678901', '-1'])('rejects the rate %s', (text) => expect(RATE_TEXT.test(text)).toBe(false));

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
    expect(exposure(new Decimal('100.01'), new Decimal('0.333333')).toFixed(4)).toBe('33.3367');
  });

  it('is never zero while debt remains', () => {
    expect(exposure(new Decimal('1'), new Decimal('0.000012103412345678')).toFixed(4)).toBe('0.0001');
  });

  it('rounds the exact product, not a 20-digit approximation of it', () => {
    expect(exposure(new Decimal('1000000000000000.0001'), new Decimal('1.000000000000000001')).toFixed(4)).toBe('1000000000000000.0012');
  });

  it('never writes a decimal in exponent notation', () => {
    expect(new Decimal('0.000000000000000001').toString()).toBe('0.000000000000000001');
    expect(new Decimal('10000000000000000000000').toString()).toBe('10000000000000000000000');
  });

  it('formats with the requested places', () => {
    expect(formatAmount(new Decimal('100'), 2)).toBe('100.00');
  });
});
