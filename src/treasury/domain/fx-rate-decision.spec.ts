import { Decimal } from 'decimal.js';
import type { FxRatePublished } from '../adapter/commands.types.js';
import { decideFxRate } from './fx-rate-decision.js';
import type { StoredQuote } from './fx-rate-decision.types.js';

const incoming = (patch: Partial<FxRatePublished> = {}): FxRatePublished => ({
  type: 'FX_RATE_PUBLISHED',
  rateId: 'R1',
  from: 'USD',
  to: 'EUR',
  rateType: 'VALUATION',
  version: 5n,
  status: 'ACTIVE',
  rate: new Decimal('0.92'),
  ...patch,
});

const stored = (patch: Partial<StoredQuote> = {}): StoredQuote => {
  const { type: _, ...quote } = incoming();
  return { ...quote, ...patch };
};

describe('decideFxRate', () => {
  it('applies a new quote', () => {
    expect(decideFxRate(incoming(), undefined, undefined)).toEqual({ outcome: 'APPLIED' });
  });

  it('treats the same quote resent as stale, regardless of trailing zeros', () => {
    expect(decideFxRate(incoming({ rate: new Decimal('0.9200') }), stored(), stored())).toEqual({ outcome: 'STALE' });
  });

  it.each<[string, Partial<StoredQuote>]>([
    ['another rate', { rate: new Decimal('0.93') }],
    ['another version', { version: 4n }],
    ['another pair', { from: 'GBP' }],
    ['another status', { status: 'SUSPENDED', rate: undefined }],
  ])('rejects the same rateId with %s', (_, patch) => {
    expect(decideFxRate(incoming(), stored(patch), undefined)).toEqual({
      outcome: 'REJECTED',
      reason: 'FX_RATE_CONFLICT',
      conflictsWith: 'R1',
    });
  });

  it('rejects another rateId for an already published version of the pair', () => {
    expect(decideFxRate(incoming({ rateId: 'R2' }), undefined, stored())).toEqual({
      outcome: 'REJECTED',
      reason: 'FX_RATE_CONFLICT',
      conflictsWith: 'R1',
    });
  });
});
