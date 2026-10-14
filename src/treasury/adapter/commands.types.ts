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

export interface InvoiceFunded {
  type: 'INVOICE_FUNDED';
  programId: string;
  invoiceId: string;
  fundingRef: string;
}

export interface InvoiceFundingReturned {
  type: 'INVOICE_FUNDING_RETURNED';
  programId: string;
  invoiceId: string;
  fundingRef: string;
}

export interface InvoicePaymentAllocated {
  type: 'INVOICE_PAYMENT_ALLOCATED';
  programId: string;
  invoiceId: string;
  allocationId: string;
  paymentId: string;
  payment: Money;
  settledAmount: Money;
  fxRateId: string | null;
}

export interface InvoiceBalanceWrittenOff {
  type: 'INVOICE_BALANCE_WRITTEN_OFF';
  programId: string;
  invoiceId: string;
  writeOffId: string;
  amount: Money;
  writeOffReason: string;
}

export interface InvoiceFundingCancelled {
  type: 'INVOICE_FUNDING_CANCELLED';
  programId: string;
  invoiceId: string;
  cancellationId: string;
  cancellationReason: string;
}

export interface InvoiceReleaseReversed {
  type: 'INVOICE_RELEASE_REVERSED';
  programId: string;
  invoiceId: string;
  reversalId: string;
  externalRef: string;
}

export type InvoiceCommand =
  | InvoiceFunded
  | InvoiceFundingReturned
  | InvoicePaymentAllocated
  | InvoiceBalanceWrittenOff
  | InvoiceFundingCancelled
  | InvoiceReleaseReversed;

export type Command = ProgramCommand | InvoiceCommand | FxRatePublished;

export type CommandResult =
  | { kind: 'command'; command: Command }
  | { kind: 'unsupported' }
  | { kind: 'invalid'; reason: string };