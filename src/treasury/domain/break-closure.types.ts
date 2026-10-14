import type { InvoiceBreakReason } from './invoice-decision.types.js';
import type { BreakReason } from './program-decision.types.js';

export type AnyBreakReason = BreakReason | InvoiceBreakReason;

export type VersionedField = 'creditLimit' | 'externalUtilized' | 'status';

export interface BreakView {
  id: string;
  reason: AnyBreakReason;
  blocking: boolean;
  programId: string | null;
  reservationId: string | null;
  messageId: string;
  resolvedAt: Date | null;
  essence: Record<string, string>;
  details: Record<string, unknown>;
}

export type ClosureCondition =
  | { kind: 'NONE' }
  | { kind: 'UNSATISFIABLE' }
  | { kind: 'LATER_MESSAGE'; types: string[] }
  | { kind: 'VERSION_ABOVE'; field: VersionedField; version: bigint }
  | { kind: 'REVERSAL_APPLIED'; reservationId: string; externalRef: string }
  | { kind: 'CANCELLATION_REVERSED'; reservationId: string };