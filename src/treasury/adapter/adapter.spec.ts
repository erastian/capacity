import { toCommand } from './commands.js';
import { parseEnvelope } from './envelope.js';
import type { RawMessage } from './envelope.types.js';

const raw = (value: unknown): RawMessage => ({
  topic: 'treasury.program-capacity',
  partition: 0,
  offset: 0n,
  key: 'P1',
  value: typeof value === 'string' ? value : JSON.stringify(value),
  timestamp: new Date(),
});

const envelope = (patch: Record<string, unknown> = {}) => ({
  messageId: 'm-1',
  type: 'LIMIT_UPDATED',
  schemaVersion: 1,
  programId: 'P1',
  version: 7,
  asOf: '2026-10-13T10:00:00Z',
  payload: { creditLimit: { amount: '1000.00', currency: 'EUR' } },
  ...patch,
});

const parse = (value: unknown) => {
  const result = parseEnvelope(raw(value));
  if (result.kind !== 'readable') throw new Error(result.reason);
  return result.envelope;
};

describe('parseEnvelope', () => {
  it.each<[string, unknown]>([
    ['not JSON', '{oops'],
    ['an array', '[1]'],
    ['no messageId', envelope({ messageId: undefined })],
    ['bad messageId', envelope({ messageId: 'has space' })],
    ['no type', envelope({ type: undefined })],
    ['no schemaVersion', envelope({ schemaVersion: undefined })],
    ['no asOf', envelope({ asOf: undefined })],
    ['asOf without zone', envelope({ asOf: '2026-10-13T10:00:00' })],
  ])('treats %s as unreadable', (_, value) => {
    expect(parseEnvelope(raw(value)).kind).toBe('unreadable');
  });

  it('reads a version given as a string', () => {
    expect(parse(envelope({ version: '9007199254740993' })).version).toBe(9007199254740993n);
  });
});

describe('toCommand', () => {
  it('builds LIMIT_UPDATED with the envelope version', () => {
    const result = toCommand(parse(envelope()));
    expect(result.kind).toBe('command');
    if (result.kind !== 'command' || result.command.type !== 'LIMIT_UPDATED') return;
    expect(result.command.creditLimit.amount.toString()).toBe('1000');
    expect(result.command.creditLimit.version).toBe(7n);
  });

  it('builds a full snapshot', () => {
    const result = toCommand(
      parse(
        envelope({
          type: 'PROGRAM_SNAPSHOT',
          version: undefined,
          payload: {
            currency: 'EUR',
            clientRef: 'C-ACME',
            creditLimit: { amount: '1000', currency: 'EUR', version: 3 },
            externalUtilized: { amount: '0', currency: 'EUR', version: 1 },
            status: { value: 'ACTIVE', version: 1 },
          },
        }),
      ),
    );
    expect(result).toMatchObject({
      kind: 'command',
      command: { type: 'PROGRAM_SNAPSHOT', clientRef: 'C-ACME', status: { value: 'ACTIVE', reason: null, version: 1n }, resolvedBreaks: [] },
    });
  });

  it.each([
    ['an unknown type', envelope({ type: 'SOMETHING_NEW' })],
    ['an unsupported schema version', envelope({ schemaVersion: 2 })],
  ])('reports %s as unsupported', (_, value) => {
    expect(toCommand(parse(value)).kind).toBe('unsupported');
  });

  describe('FX_RATE_PUBLISHED', () => {
    const quote = (payload: Record<string, unknown>) =>
      envelope({
        type: 'FX_RATE_PUBLISHED',
        programId: undefined,
        version: 3,
        payload: { rateId: 'R-1', from: 'USD', to: 'EUR', rateType: 'VALUATION', status: 'ACTIVE', rate: '0.000012103412345678', ...payload },
      });

    it('keeps the rate exactly with 18 decimals', () => {
      const result = toCommand(parse(quote({})));
      if (result.kind !== 'command' || result.command.type !== 'FX_RATE_PUBLISHED') throw new Error('expected a quote');
      expect(result.command.rate?.toFixed(18)).toBe('0.000012103412345678');
      expect(result.command.version).toBe(3n);
    });

    it('accepts a suspension without a rate', () => {
      expect(toCommand(parse(quote({ status: 'SUSPENDED', rate: undefined }))).kind).toBe('command');
    });

    it.each<[string, Record<string, unknown>]>([
      ['19 decimals', { rate: '0.0000121034123456789' }],
      ['zero rate', { rate: '0' }],
      ['numeric rate', { rate: 0.92 }],
      ['active without rate', { rate: undefined }],
      ['suspended with rate', { status: 'SUSPENDED' }],
      ['same currencies', { to: 'USD' }],
      ['unknown rate type', { rateType: 'SPOT' }],
      ['missing rateId', { rateId: undefined }],
    ])('rejects %s', (_, payload) => {
      expect(toCommand(parse(quote(payload))).kind).toBe('invalid');
    });
  });

  describe('invoice messages', () => {
    const invoice = (type: string, payload: Record<string, unknown>) =>
      envelope({ type, version: undefined, payload: { invoiceId: 'INV-1', ...payload } });

    const allocation = (payload: Record<string, unknown> = {}) =>
      invoice('INVOICE_PAYMENT_ALLOCATED', {
        allocationId: 'A-1',
        paymentId: 'PAY-1',
        payment: { amount: '100.00', currency: 'GBP' },
        settledAmount: { amount: '123.45', currency: 'USD' },
        fxRateId: 'R-1',
        ...payload,
      });

    it.each<[string, ReturnType<typeof envelope>]>([
      ['a funding', invoice('INVOICE_FUNDED', { fundingRef: 'F-1' })],
      ['a funding return', invoice('INVOICE_FUNDING_RETURNED', { fundingRef: 'F-1' })],
      ['a payment in another currency', allocation()],
      [
        'a payment in the invoice currency',
        allocation({ payment: { amount: '10.00', currency: 'USD' }, settledAmount: { amount: '10.00', currency: 'USD' }, fxRateId: undefined }),
      ],
      ['a write-off', invoice('INVOICE_BALANCE_WRITTEN_OFF', { writeOffId: 'W-1', amount: { amount: '0.03', currency: 'USD' }, writeOffReason: 'BANK_CHARGES' })],
      ['a cancellation', invoice('INVOICE_FUNDING_CANCELLED', { cancellationId: 'C-1', cancellationReason: 'PAYOUT_FAILED' })],
      ['a reversal', invoice('INVOICE_RELEASE_REVERSED', { reversalId: 'REV-1', externalRef: 'A-1' })],
    ])('builds %s', (_, value) => {
      expect(toCommand(parse(value))).toMatchObject({ kind: 'command', command: { type: value.type, invoiceId: 'INV-1', programId: 'P1' } });
    });

    it.each<[string, ReturnType<typeof envelope>]>([
      ['a payment without fxRateId in another currency', allocation({ fxRateId: undefined })],
      [
        'a payment with fxRateId in the same currency',
        allocation({ payment: { amount: '10.00', currency: 'USD' }, settledAmount: { amount: '10.00', currency: 'USD' } }),
      ],
      [
        'different amounts in the same currency',
        allocation({ payment: { amount: '10.00', currency: 'USD' }, settledAmount: { amount: '9.99', currency: 'USD' }, fxRateId: undefined }),
      ],
      ['more decimals than the currency allows', allocation({ settledAmount: { amount: '123.456', currency: 'USD' } })],
      ['decimals in a zero-decimal currency', allocation({ payment: { amount: '100.5', currency: 'JPY' } })],
      ['a zero amount', allocation({ payment: { amount: '0', currency: 'GBP' } })],
      ['a missing invoiceId', invoice('INVOICE_FUNDED', { invoiceId: undefined, fundingRef: 'F-1' })],
      ['a missing fundingRef', invoice('INVOICE_FUNDED', {})],
      ['a write-off without reason', invoice('INVOICE_BALANCE_WRITTEN_OFF', { writeOffId: 'W-1', amount: { amount: '1', currency: 'USD' } })],
      ['a reversal without externalRef', invoice('INVOICE_RELEASE_REVERSED', { reversalId: 'REV-1' })],
    ])('rejects %s', (_, value) => {
      expect(toCommand(parse(value)).kind).toBe('invalid');
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['missing programId', { programId: undefined }],
    ['missing version', { version: undefined }],
    ['negative version', { version: -1 }],
    ['negative amount', { payload: { creditLimit: { amount: '-1', currency: 'EUR' } } }],
    ['numeric amount', { payload: { creditLimit: { amount: 1000, currency: 'EUR' } } }],
    ['five decimals', { payload: { creditLimit: { amount: '1.00001', currency: 'EUR' } } }],
    ['unknown currency', { payload: { creditLimit: { amount: '1', currency: 'XXX' } } }],
    ['bad status', { type: 'PROGRAM_STATUS_CHANGED', payload: { status: 'PAUSED' } }],
  ])('reports %s as invalid', (_, patch) => {
    expect(toCommand(parse(envelope(patch))).kind).toBe('invalid');
  });
});