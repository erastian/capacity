import { Decimal } from 'decimal.js';
import { capacityOf } from './capacity.js';

const balances = { creditLimit: new Decimal(100), externalUtilized: new Decimal(30), reserved: new Decimal(50) };

describe('capacityOf', () => {
  it('is the limit minus the utilisation', () => {
    const position = capacityOf(balances);
    expect(position.totalUtilized.toString()).toBe('80');
    expect(position.available.toString()).toBe('20');
    expect(position.overLimit.toString()).toBe('0');
  });

  it('never goes negative and reports the excess', () => {
    const position = capacityOf({ ...balances, creditLimit: new Decimal(60) });
    expect(position.available.toString()).toBe('0');
    expect(position.overLimit.toString()).toBe('20');
  });
});