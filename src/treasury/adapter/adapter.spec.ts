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