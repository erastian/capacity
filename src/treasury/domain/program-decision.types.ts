import type { ProgramStatus } from '../../shared/domain/program.types.js';
import type { Decimal } from 'decimal.js';
import type { VersionedStatus } from '../adapter/commands.types.js';

export interface ProgramView {
  id: string;
  externalId: string;
  clientRef: string;
  currency: string;
  creditLimit: Decimal;
  creditLimitVersion: bigint | null;
  externalUtilized: Decimal;
  externalUtilizedVersion: bigint | null;
  reserved: Decimal;
  status: ProgramStatus;
  statusReason: string | null;
  statusVersion: bigint | null;
}

export type BreakReason =
  | 'CURRENCY_MISMATCH'
  | 'VERSION_CONFLICT'
  | 'CLIENT_MISMATCH'
  | 'INVALID_STATUS_TRANSITION';

export interface BreakSpec {
  reason: BreakReason;
  blocking: boolean;
  essence: Record<string, string>;
  details: Record<string, unknown>;
}

export interface VersionedAmount {
  amount: Decimal;
  version: bigint;
}

export interface ProgramChanges {
  creditLimit?: VersionedAmount;
  externalUtilized?: VersionedAmount;
  status?: VersionedStatus;
}

export interface NewProgram {
  externalId: string;
  clientRef: string;
  currency: string;
  creditLimit: VersionedAmount;
  externalUtilized: VersionedAmount;
  status: VersionedStatus;
}

export type LedgerKind =
  | 'TREASURY_LIMIT_UPDATED'
  | 'TREASURY_EXTERNAL_UTILIZATION_UPDATED'
  | 'TREASURY_SNAPSHOT';

export type ProgramPlan =
  | { outcome: 'APPLIED'; create: NewProgram; ledger: LedgerKind }
  | { outcome: 'APPLIED'; changes: ProgramChanges; ledger: LedgerKind | null }
  | { outcome: 'STALE' }
  | { outcome: 'REJECTED'; reason: BreakReason; break: BreakSpec };