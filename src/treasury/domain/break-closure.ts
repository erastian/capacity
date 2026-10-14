import type { ProgramView } from './program-decision.types.js';
import type { BreakView, ClosureCondition, VersionedField } from './break-closure.types.js';

const NONE: ClosureCondition = { kind: 'NONE' };

const UNSATISFIABLE: ClosureCondition = { kind: 'UNSATISFIABLE' };

const FIELD_MESSAGES: Record<string, string[]> = {
  creditLimit: ['LIMIT_UPDATED', 'PROGRAM_SNAPSHOT'],
  externalUtilized: ['EXTERNAL_UTILIZATION_UPDATED', 'PROGRAM_SNAPSHOT'],
  currency: ['PROGRAM_SNAPSHOT'],
};

const VERSIONED_FIELDS: readonly VersionedField[] = ['creditLimit', 'externalUtilized', 'status'];

export function closureCondition(view: BreakView): ClosureCondition {
  if (view.programId === null || !view.blocking) return NONE;

  switch (view.reason) {
    case 'CURRENCY_MISMATCH': {
      const types = FIELD_MESSAGES[view.essence.field ?? ''];
      return types ? { kind: 'LATER_MESSAGE', types } : UNSATISFIABLE;
    }
    case 'CLIENT_MISMATCH':
      return { kind: 'LATER_MESSAGE', types: ['PROGRAM_SNAPSHOT'] };
    case 'VERSION_CONFLICT': {
      const field = view.essence.field as VersionedField;
      const version = view.essence.version;
      if (!VERSIONED_FIELDS.includes(field) || version === undefined || !/^\d+$/.test(version)) return UNSATISFIABLE;
      return { kind: 'VERSION_ABOVE', field, version: BigInt(version) };
    }
    case 'UNKNOWN_RELEASE': {
      const externalRef = view.details.externalRef;
      if (view.reservationId === null || typeof externalRef !== 'string') return UNSATISFIABLE;
      return { kind: 'REVERSAL_APPLIED', reservationId: view.reservationId, externalRef };
    }
    case 'FUNDED_AFTER_CANCELLATION':
      return view.reservationId === null
        ? UNSATISFIABLE
        : { kind: 'CANCELLATION_REVERSED', reservationId: view.reservationId };
    default:
      return NONE;
  }
}

export function versionAbove(program: ProgramView, field: VersionedField, version: bigint): boolean {
  const current =
    field === 'creditLimit'
      ? program.creditLimitVersion
      : field === 'externalUtilized'
        ? program.externalUtilizedVersion
        : program.statusVersion;
  return current !== null && current > version;
}