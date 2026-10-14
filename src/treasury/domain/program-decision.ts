import type { ProgramStatus } from '../../shared/domain/program.types.js';
import { Decimal } from 'decimal.js';
import '../../shared/money/precision.js';
import type {
  Money,
  ProgramCommand,
  ProgramSnapshot,
  VersionedMoney,
} from '../adapter/commands.types.js';
import type {
  BreakReason,
  ProgramChanges,
  ProgramPlan,
  ProgramView,
} from './program-decision.types.js';
import { decideField, isReinstatementAllowed, isStatusChangeAllowed } from './versioning.js';
import type { FieldDecision } from './versioning.types.js';

const sameAmount = (a: Decimal, b: Decimal) => a.eq(b);
const sameStatus = (
  a: { value: ProgramStatus; reason: string | null },
  b: { value: ProgramStatus; reason: string | null },
) => a.value === b.value;

function reject(reason: BreakReason, blocking: boolean, essence: Record<string, string>, details: Record<string, unknown>): ProgramPlan {
  return { outcome: 'REJECTED', reason, break: { reason, blocking, essence, details } };
}

function currencyMismatch(field: string, expected: string, received: Money): ProgramPlan | undefined {
  if (received.currency === expected) return undefined;
  return reject('CURRENCY_MISMATCH', true, { field, currency: received.currency }, {
    field,
    expected,
    received: received.currency,
  });
}

function versionConflict(field: string, version: bigint, current: unknown, received: unknown): ProgramPlan {
  return reject('VERSION_CONFLICT', true, { field, version: version.toString() }, {
    field,
    version: version.toString(),
    expected: current,
    received,
  });
}

function decideAmount(
  field: 'creditLimit' | 'externalUtilized',
  current: { value: Decimal; version: bigint | null },
  incoming: VersionedMoney,
): { decision: FieldDecision; conflict?: ProgramPlan } {
  const decision = decideField(current, { value: incoming.amount, version: incoming.version }, sameAmount);
  return decision === 'conflict'
    ? { decision, conflict: versionConflict(field, incoming.version, current.value.toString(), incoming.amount.toString()) }
    : { decision };
}

function decideStatus(
  program: ProgramView,
  incoming: { value: ProgramStatus; reason: string | null; version: bigint },
): { decision: FieldDecision; rejection?: ProgramPlan } {
  const decision = decideField(
    { value: { value: program.status, reason: program.statusReason }, version: program.statusVersion },
    { value: incoming, version: incoming.version },
    sameStatus,
  );
  if (decision === 'conflict') {
    return { decision, rejection: versionConflict('status', incoming.version, program.status, incoming.value) };
  }
  if (decision === 'apply' && !isStatusChangeAllowed(program.status, incoming.value)) {
    return {
      decision,
      rejection: reject('INVALID_STATUS_TRANSITION', false, { from: program.status, to: incoming.value }, {
        from: program.status,
        to: incoming.value,
        version: incoming.version.toString(),
      }),
    };
  }
  return { decision };
}

function createFromSnapshot(snapshot: ProgramSnapshot): ProgramPlan {
  const mismatch =
    currencyMismatch('creditLimit', snapshot.currency, snapshot.creditLimit) ??
    currencyMismatch('externalUtilized', snapshot.currency, snapshot.externalUtilized);
  if (mismatch) return mismatch;
  return {
    outcome: 'APPLIED',
    ledger: 'TREASURY_SNAPSHOT',
    create: {
      externalId: snapshot.programId,
      clientRef: snapshot.clientRef,
      currency: snapshot.currency,
      creditLimit: { amount: snapshot.creditLimit.amount, version: snapshot.creditLimit.version },
      externalUtilized: { amount: snapshot.externalUtilized.amount, version: snapshot.externalUtilized.version },
      status: snapshot.status,
    },
  };
}

function applySnapshot(program: ProgramView, snapshot: ProgramSnapshot): ProgramPlan {
  if (snapshot.currency !== program.currency) {
    return reject('CURRENCY_MISMATCH', true, { field: 'currency', currency: snapshot.currency }, {
      field: 'currency',
      expected: program.currency,
      received: snapshot.currency,
    });
  }
  const mismatch =
    currencyMismatch('creditLimit', program.currency, snapshot.creditLimit) ??
    currencyMismatch('externalUtilized', program.currency, snapshot.externalUtilized);
  if (mismatch) return mismatch;

  if (snapshot.clientRef !== program.clientRef) {
    return reject('CLIENT_MISMATCH', true, { clientRef: snapshot.clientRef }, {
      expected: program.clientRef,
      received: snapshot.clientRef,
    });
  }

  const limit = decideAmount('creditLimit', { value: program.creditLimit, version: program.creditLimitVersion }, snapshot.creditLimit);
  if (limit.conflict) return limit.conflict;
  const utilized = decideAmount(
    'externalUtilized',
    { value: program.externalUtilized, version: program.externalUtilizedVersion },
    snapshot.externalUtilized,
  );
  if (utilized.conflict) return utilized.conflict;
  const status = decideStatus(program, snapshot.status);
  if (status.rejection) return status.rejection;

  const changes: ProgramChanges = {
    ...(limit.decision === 'apply' ? { creditLimit: snapshot.creditLimit } : {}),
    ...(utilized.decision === 'apply' ? { externalUtilized: snapshot.externalUtilized } : {}),
    ...(status.decision === 'apply' ? { status: snapshot.status } : {}),
  };
  return Object.keys(changes).length === 0
    ? { outcome: 'STALE' }
    : { outcome: 'APPLIED', changes, ledger: 'TREASURY_SNAPSHOT' };
}

export function decideProgramCommand(command: ProgramCommand, program: ProgramView | undefined): ProgramPlan {
  if (!program) {
    if (command.type !== 'PROGRAM_SNAPSHOT') throw new Error(`${command.type} needs an existing program`);
    return createFromSnapshot(command);
  }

  switch (command.type) {
    case 'PROGRAM_SNAPSHOT':
      return applySnapshot(program, command);

    case 'LIMIT_UPDATED': {
      const mismatch = currencyMismatch('creditLimit', program.currency, command.creditLimit);
      if (mismatch) return mismatch;
      const { decision, conflict } = decideAmount(
        'creditLimit',
        { value: program.creditLimit, version: program.creditLimitVersion },
        command.creditLimit,
      );
      if (conflict) return conflict;
      return decision === 'apply'
        ? { outcome: 'APPLIED', changes: { creditLimit: command.creditLimit }, ledger: 'TREASURY_LIMIT_UPDATED' }
        : { outcome: 'STALE' };
    }

    case 'EXTERNAL_UTILIZATION_UPDATED': {
      const mismatch = currencyMismatch('externalUtilized', program.currency, command.externalUtilized);
      if (mismatch) return mismatch;
      const { decision, conflict } = decideAmount(
        'externalUtilized',
        { value: program.externalUtilized, version: program.externalUtilizedVersion },
        command.externalUtilized,
      );
      if (conflict) return conflict;
      return decision === 'apply'
        ? {
            outcome: 'APPLIED',
            changes: { externalUtilized: command.externalUtilized },
            ledger: 'TREASURY_EXTERNAL_UTILIZATION_UPDATED',
          }
        : { outcome: 'STALE' };
    }

    case 'PROGRAM_STATUS_CHANGED': {
      const { decision, rejection } = decideStatus(program, command.status);
      if (rejection) return rejection;
      return decision === 'apply'
        ? { outcome: 'APPLIED', changes: { status: command.status }, ledger: 'TREASURY_SNAPSHOT' }
        : { outcome: 'STALE' };
    }

    case 'PROGRAM_REINSTATED': {
      const incoming = { value: 'ACTIVE' as const, reason: command.amendmentRef, version: command.version };
      const decision = decideField(
        { value: { value: program.status, reason: program.statusReason }, version: program.statusVersion },
        { value: incoming, version: command.version },
        sameStatus,
      );
      if (decision === 'stale') return { outcome: 'STALE' };
      if (!isReinstatementAllowed(program.status)) {
        return reject('INVALID_STATUS_TRANSITION', false, { from: program.status, to: 'ACTIVE' }, {
          from: program.status,
          to: 'ACTIVE',
          via: 'PROGRAM_REINSTATED',
          amendmentRef: command.amendmentRef,
        });
      }
      if (decision === 'conflict') {
        return versionConflict('status', command.version, program.status, 'ACTIVE');
      }
      return { outcome: 'APPLIED', changes: { status: incoming }, ledger: 'TREASURY_SNAPSHOT' };
    }
  }
}