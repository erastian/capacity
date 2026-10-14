import { Decimal } from 'decimal.js';
import { assess } from './assess.js';
import type { AssessContext, FxQuote, ProgramState, ReserveInput } from './assess.types.js';

const NOW = new Date('2026-10-13T12:00:00Z');
const HOUR = 60 * 60 * 1000;

const context: AssessContext = {
  businessDate: '2026-10-13',
  now: NOW,
  fxMaxAgeMs: 6 * HOUR,
};

const program = (patch: Partial<ProgramState> = {}): ProgramState => ({
  id: 'p',
  externalId: 'P1',
  clientRef: 'C1',
  currency: 'EUR',
  creditLimit: new Decimal(1000),
  externalUtilized: new Decimal(200),
  reserved: new Decimal(300),
  status: 'ACTIVE',
  openBlockingBreaks: 0,
  ...patch,
});

const input = (patch: Partial<ReserveInput> = {}): ReserveInput => ({
  originalAmount: new Decimal(100),
  currency: 'EUR',
  dueDate: '2026-12-31',
  ...patch,
});

const quote = (patch: Partial<FxQuote> = {}): FxQuote => ({
  id: 'fx',
  rateId: 'R1',
  status: 'ACTIVE',
  rate: new Decimal('0.9'),
  effectiveAsOf: new Date(NOW.getTime() - HOUR),
  ...patch,
});

describe('assess', () => {
  it('declines an exposure beyond the column range as insufficient capacity, never storing it', () => {
    const result = assess(
      program({ creditLimit: new Decimal('9999999999999999.9999'), externalUtilized: new Decimal(0), reserved: new Decimal(0) }),
      input({ currency: 'USD', originalAmount: new Decimal('9999999999999999.9999') }),
      quote({ rate: new Decimal('99999999999999999999') }),
      context,
    );
    expect(result).toMatchObject({ outcome: 'decline', code: 'INSUFFICIENT_CAPACITY' });
  });

  it('reserves the nominal in the same currency', () => {
    const result = assess(program(), input(), undefined, context);
    expect(result).toMatchObject({ outcome: 'reserve' });
    expect(result.amount?.toString()).toBe('100');
    expect(result.fx).toBeUndefined();
  });

  it('converts with the valuation rate, rounding up', () => {
    const result = assess(
      program(),
      input({ currency: 'USD', originalAmount: new Decimal('100.01') }),
      quote({ rate: new Decimal('0.333333') }),
      context,
    );
    expect(result).toMatchObject({ outcome: 'reserve' });
    expect(result.amount?.toFixed(4)).toBe('33.3367');
    expect(result.fx?.rateId).toBe('R1');
  });

  it('accepts a due date equal to the business date', () => {
    expect(
      assess(program(), input({ dueDate: '2026-10-13' }), undefined, context).outcome,
    ).toBe('reserve');
  });

  it('fits exactly the available capacity', () => {
    expect(
      assess(program(), input({ originalAmount: new Decimal(500) }), undefined, context)
        .outcome,
    ).toBe('reserve');
  });

  it.each<[string, Partial<ProgramState>, Partial<ReserveInput>, FxQuote | undefined, string]>([
    ['past due', {}, { dueDate: '2026-10-12' }, undefined, 'INVOICE_PAST_DUE'],
    ['suspended', { status: 'SUSPENDED' }, {}, undefined, 'PROGRAM_SUSPENDED'],
    ['closed', { status: 'CLOSED' }, {}, undefined, 'PROGRAM_CLOSED'],
    ['blocking break', { openBlockingBreaks: 1 }, {}, undefined, 'PROGRAM_ON_HOLD'],
    ['no rate', {}, { currency: 'USD' }, undefined, 'FX_RATE_UNAVAILABLE'],
    ['suspended rate', {}, { currency: 'USD' }, quote({ status: 'SUSPENDED', rate: undefined }), 'FX_RATE_SUSPENDED'],
    ['stale rate', {}, { currency: 'USD' }, quote({ effectiveAsOf: new Date(NOW.getTime() - 7 * HOUR) }), 'FX_RATE_STALE'],
    ['over capacity', {}, { originalAmount: new Decimal('500.01') }, undefined, 'INSUFFICIENT_CAPACITY'],
    ['program over limit', { creditLimit: new Decimal(400) }, { originalAmount: new Decimal('0.01') }, undefined, 'INSUFFICIENT_CAPACITY'],
  ])('declines when %s', (_, programPatch, inputPatch, fx, code) => {
    expect(assess(program(programPatch), input(inputPatch), fx, context)).toMatchObject({
      outcome: 'decline',
      code,
    });
  });

  it('checks in the documented order: due date before status before capacity', () => {
    expect(
      assess(
        program({ status: 'CLOSED', creditLimit: new Decimal(0) }),
        input({ dueDate: '2026-01-01' }),
        undefined,
        context,
      ),
    ).toMatchObject({ code: 'INVOICE_PAST_DUE' });
  });

  it('ignores a rate when currencies match', () => {
    expect(
      assess(program(), input(), quote({ status: 'SUSPENDED' }), context).outcome,
    ).toBe('reserve');
  });
});