import { Decimal } from 'decimal.js';
import type { ProgramCommand, ProgramSnapshot } from '../adapter/commands.types.js';
import { decideProgramCommand, overLimit } from './program-decision.js';
import type { ProgramView } from './program-decision.types.js';

const money = (amount: string, version: bigint, currency = 'EUR') => ({
  amount: new Decimal(amount),
  currency,
  version,
});

const program = (patch: Partial<ProgramView> = {}): ProgramView => ({
  id: 'p',
  externalId: 'P1',
  clientRef: 'C1',
  currency: 'EUR',
  creditLimit: new Decimal(1000),
  creditLimitVersion: 5n,
  externalUtilized: new Decimal(100),
  externalUtilizedVersion: 3n,
  reserved: new Decimal(0),
  status: 'ACTIVE',
  statusReason: null,
  statusVersion: 2n,
  ...patch,
});

const snapshot = (patch: Partial<ProgramSnapshot> = {}): ProgramSnapshot => ({
  type: 'PROGRAM_SNAPSHOT',
  programId: 'P1',
  currency: 'EUR',
  clientRef: 'C1',
  creditLimit: money('1000', 5n),
  externalUtilized: money('100', 3n),
  status: { value: 'ACTIVE', reason: null, version: 2n },
  resolvedBreaks: [],
  ...patch,
});

const limit = (amount: string, version: bigint, currency = 'EUR'): ProgramCommand => ({
  type: 'LIMIT_UPDATED',
  programId: 'P1',
  creditLimit: money(amount, version, currency),
});

describe('creating snapshot', () => {
  it('creates the program', () => {
    expect(decideProgramCommand(snapshot(), undefined)).toMatchObject({
      outcome: 'APPLIED',
      ledger: 'TREASURY_SNAPSHOT',
      create: { externalId: 'P1', clientRef: 'C1', currency: 'EUR' },
    });
  });

  it('rejects inconsistent currencies without creating anything', () => {
    expect(
      decideProgramCommand(snapshot({ creditLimit: money('1000', 5n, 'USD') }), undefined),
    ).toMatchObject({ outcome: 'REJECTED', reason: 'CURRENCY_MISMATCH' });
  });
});

describe('snapshot of an existing program', () => {
  it('is stale when nothing is newer', () => {
    expect(decideProgramCommand(snapshot(), program())).toEqual({ outcome: 'STALE' });
  });

  it('applies only the newer fields', () => {
    const plan = decideProgramCommand(
      snapshot({ creditLimit: money('800', 6n), externalUtilized: money('999', 2n) }),
      program(),
    );
    expect(plan).toMatchObject({ outcome: 'APPLIED', ledger: 'TREASURY_SNAPSHOT' });
    if (plan.outcome !== 'APPLIED' || !('changes' in plan)) throw new Error('expected changes');
    expect(Object.keys(plan.changes)).toEqual(['creditLimit']);
  });

  it.each<[string, Partial<ProgramSnapshot>, Partial<ProgramView>, string, boolean]>([
    ['other programme currency', { currency: 'USD' }, {}, 'CURRENCY_MISMATCH', true],
    ['field in another currency', { externalUtilized: money('100', 4n, 'USD') }, {}, 'CURRENCY_MISMATCH', true],
    ['another owner', { clientRef: 'C2' }, {}, 'CLIENT_MISMATCH', true],
    ['same version, other limit', { creditLimit: money('900', 5n) }, {}, 'VERSION_CONFLICT', true],
    ['reopening a closed programme', { status: { value: 'ACTIVE', reason: null, version: 9n } }, { status: 'CLOSED' }, 'INVALID_STATUS_TRANSITION', false],
  ])('rejects the whole snapshot on %s', (_, patch, programPatch, reason, blocking) => {
    expect(
      decideProgramCommand(snapshot({ ...patch, creditLimit: patch.creditLimit ?? money('1', 99n) }), program(programPatch)),
    ).toMatchObject({ outcome: 'REJECTED', reason, break: { blocking } });
  });
});

describe('single field messages', () => {
  it('applies a newer limit', () => {
    expect(decideProgramCommand(limit('500', 6n), program())).toMatchObject({
      outcome: 'APPLIED',
      ledger: 'TREASURY_LIMIT_UPDATED',
      changes: { creditLimit: { version: 6n } },
    });
  });

  it('ignores an older limit', () => {
    expect(decideProgramCommand(limit('500', 4n), program())).toEqual({ outcome: 'STALE' });
  });

  it('rejects a limit in a foreign currency', () => {
    expect(decideProgramCommand(limit('500', 6n, 'USD'), program())).toMatchObject({
      reason: 'CURRENCY_MISMATCH',
    });
  });

  it('suspends an active programme', () => {
    expect(
      decideProgramCommand(
        { type: 'PROGRAM_STATUS_CHANGED', programId: 'P1', status: { value: 'SUSPENDED', reason: 'review', version: 3n } },
        program(),
      ),
    ).toMatchObject({ outcome: 'APPLIED', changes: { status: { value: 'SUSPENDED' } } });
  });
});

describe('reinstatement', () => {
  const reinstate = (version: bigint): ProgramCommand => ({
    type: 'PROGRAM_REINSTATED',
    programId: 'P1',
    amendmentRef: 'AMD-1',
    version,
  });

  it('reopens a closed programme with the amendment as reason', () => {
    expect(decideProgramCommand(reinstate(3n), program({ status: 'CLOSED' }))).toMatchObject({
      outcome: 'APPLIED',
      changes: { status: { value: 'ACTIVE', reason: 'AMD-1', version: 3n } },
    });
  });

  it('rejects reinstating an active programme', () => {
    expect(decideProgramCommand(reinstate(3n), program())).toMatchObject({
      reason: 'INVALID_STATUS_TRANSITION',
      break: { blocking: false },
    });
  });

  it('is stale when already applied', () => {
    expect(decideProgramCommand(reinstate(1n), program({ status: 'CLOSED' }))).toEqual({ outcome: 'STALE' });
  });
});

describe('overLimit', () => {
  it('is zero within the limit and the excess beyond it', () => {
    const balances = { creditLimit: new Decimal(100), externalUtilized: new Decimal(30), reserved: new Decimal(50) };
    expect(overLimit(balances).toString()).toBe('0');
    expect(overLimit({ ...balances, creditLimit: new Decimal(60) }).toString()).toBe('20');
  });
});