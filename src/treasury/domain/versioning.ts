import type { ProgramStatus } from '../../shared/domain/program.types.js';
import type { FieldDecision, Versioned } from './versioning.types.js';

export function decideField<T>(
  current: Versioned<T>,
  incoming: { value: T; version: bigint },
  equals: (a: T, b: T) => boolean,
): FieldDecision {
  if (current.version === null || incoming.version > current.version) return 'apply';
  if (incoming.version < current.version) return 'stale';
  return equals(current.value, incoming.value) ? 'stale' : 'conflict';
}

export function isStatusChangeAllowed(from: ProgramStatus, to: ProgramStatus): boolean {
  if (from === to) return true;
  if (from === 'CLOSED') return false;
  return true;
}

export function isReinstatementAllowed(from: ProgramStatus): boolean {
  return from === 'CLOSED';
}