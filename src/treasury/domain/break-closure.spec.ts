import { Decimal } from 'decimal.js';
import { closureCondition, versionAbove } from './break-closure.js';
import type { BreakView } from './break-closure.types.js';
import type { ProgramView } from './program-decision.types.js';

const view = (patch: Partial<BreakView> = {}): BreakView => ({
  id: 'b-1',
  reason: 'VERSION_CONFLICT',
  blocking: true,
  programId: 'program-1',
  reservationId: null,
  messageId: 'm-1',
  resolvedAt: null,
  essence: { field: 'creditLimit', version: '5' },
  details: {},
  ...patch,
});

const program = (patch: Partial<ProgramView> = {}): ProgramView => ({
  id: 'program-1',
  externalId: 'P-1',
  clientRef: 'C-1',
  currency: 'EUR',
  creditLimit: new Decimal(1000),
  creditLimitVersion: 5n,
  externalUtilized: new Decimal(0),
  externalUtilizedVersion: 2n,
  reserved: new Decimal(0),
  status: 'ACTIVE',
  statusReason: null,
  statusVersion: 3n,
  ...patch,
});

describe('closureCondition', () => {
  it.each<[string, Partial<BreakView>]>([
    ['a non-blocking break', { reason: 'OVERPAYMENT', blocking: false }],
    ['an invoice currency mismatch', { reason: 'CURRENCY_MISMATCH', blocking: false, essence: { reservationId: 'r-1' } }],
    ['a break without a programme', { reason: 'CLIENT_MISMATCH', blocking: false, programId: null }],
  ])('needs nothing but the confirmation for %s', (_, patch) => {
    expect(closureCondition(view(patch))).toEqual({ kind: 'NONE' });
  });

  it.each<[string, string[]]>([
    ['creditLimit', ['LIMIT_UPDATED', 'PROGRAM_SNAPSHOT']],
    ['externalUtilized', ['EXTERNAL_UTILIZATION_UPDATED', 'PROGRAM_SNAPSHOT']],
    ['currency', ['PROGRAM_SNAPSHOT']],
  ])('waits for a later accepted message about %s after a currency mismatch', (field, types) => {
    expect(closureCondition(view({ reason: 'CURRENCY_MISMATCH', essence: { field, currency: 'USD' } }))).toEqual({
      kind: 'LATER_MESSAGE',
      types,
    });
  });

  it('waits for a later accepted snapshot after a client mismatch', () => {
    expect(closureCondition(view({ reason: 'CLIENT_MISMATCH', essence: { clientRef: 'C-2' } }))).toEqual({
      kind: 'LATER_MESSAGE',
      types: ['PROGRAM_SNAPSHOT'],
    });
  });

  it('waits for the field version to move past the conflict', () => {
    expect(closureCondition(view())).toEqual({ kind: 'VERSION_ABOVE', field: 'creditLimit', version: 5n });
  });

  it('waits for the reversal of the same release', () => {
    expect(
      closureCondition(view({ reason: 'UNKNOWN_RELEASE', reservationId: 'r-1', essence: { reservationId: 'r-1' }, details: { externalRef: 'A-7' } })),
    ).toEqual({ kind: 'REVERSAL_APPLIED', reservationId: 'r-1', externalRef: 'A-7' });
  });

  it('waits for the cancellation to be reversed after a funding of a cancelled invoice', () => {
    expect(closureCondition(view({ reason: 'FUNDED_AFTER_CANCELLATION', reservationId: 'r-1' }))).toEqual({
      kind: 'CANCELLATION_REVERSED',
      reservationId: 'r-1',
    });
  });

  it.each<[string, Partial<BreakView>]>([
    ['an unknown field', { reason: 'CURRENCY_MISMATCH', essence: { field: 'limit' } }],
    ['a version conflict without a version', { essence: { field: 'status' } }],
    ['an unknown release without a reference', { reason: 'UNKNOWN_RELEASE', reservationId: 'r-1' }],
    ['a funding break without a reservation', { reason: 'FUNDED_AFTER_CANCELLATION' }],
  ])('refuses to close %s rather than guess', (_, patch) => {
    expect(closureCondition(view(patch))).toEqual({ kind: 'UNSATISFIABLE' });
  });
});

describe('versionAbove', () => {
  it.each<[string, Partial<ProgramView>, bigint, boolean]>([
    ['the same version', {}, 5n, false],
    ['a newer version', { creditLimitVersion: 6n }, 5n, true],
    ['no version yet', { creditLimitVersion: null }, 0n, false],
  ])('compares %s', (_, patch, version, expected) => {
    expect(versionAbove(program(patch), 'creditLimit', version)).toBe(expected);
  });

  it('reads the version of the field in question', () => {
    expect(versionAbove(program(), 'status', 2n)).toBe(true);
    expect(versionAbove(program(), 'externalUtilized', 2n)).toBe(false);
  });
});
