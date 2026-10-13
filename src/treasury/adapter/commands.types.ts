import type { ProgramStatus } from '../../shared/domain/program.types.js';
import type { Decimal } from 'decimal.js';

export interface Money {
  amount: Decimal;
  currency: string;
}

export interface VersionedMoney extends Money {
  version: bigint;
}

export interface VersionedStatus {
  value: ProgramStatus;
  reason: string | null;
  version: bigint;
}

export interface ProgramSnapshot {
  type: 'PROGRAM_SNAPSHOT';
  programId: string;
  currency: string;
  clientRef: string;
  creditLimit: VersionedMoney;
  externalUtilized: VersionedMoney;
  status: VersionedStatus;
  resolvedBreaks: string[];
}

export interface LimitUpdated {
  type: 'LIMIT_UPDATED';
  programId: string;
  creditLimit: VersionedMoney;
}

export interface ExternalUtilizationUpdated {
  type: 'EXTERNAL_UTILIZATION_UPDATED';
  programId: string;
  externalUtilized: VersionedMoney;
}

export interface ProgramStatusChanged {
  type: 'PROGRAM_STATUS_CHANGED';
  programId: string;
  status: VersionedStatus;
}

export interface ProgramReinstated {
  type: 'PROGRAM_REINSTATED';
  programId: string;
  amendmentRef: string;
  version: bigint;
}

export type ProgramCommand =
  | ProgramSnapshot
  | LimitUpdated
  | ExternalUtilizationUpdated
  | ProgramStatusChanged
  | ProgramReinstated;

export type FxRateType = 'VALUATION' | 'CONVERSION';

export type FxRateStatus = 'ACTIVE' | 'SUSPENDED';

export interface FxRatePublished {
  type: 'FX_RATE_PUBLISHED';
  rateId: string;
  from: string;
  to: string;
  rateType: FxRateType;
  version: bigint;
  status: FxRateStatus;
  rate?: Decimal;
}

export type Command = ProgramCommand | FxRatePublished;

export type CommandResult =
  | { kind: 'command'; command: Command }
  | { kind: 'unsupported' }
  | { kind: 'invalid'; reason: string };