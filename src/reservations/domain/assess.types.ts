import type { ProgramStatus } from '../../shared/domain/program.types.js';
import type { Decimal } from 'decimal.js';

export interface ProgramState {
  id: string;
  externalId: string;
  clientRef: string;
  currency: string;
  creditLimit: Decimal;
  externalUtilized: Decimal;
  reserved: Decimal;
  status: ProgramStatus;
  openBlockingBreaks: number;
}

export interface FxQuote {
  id: string;
  rateId: string;
  status: 'ACTIVE' | 'SUSPENDED';
  rate?: Decimal;
  effectiveAsOf: Date;
}

export interface ReserveInput {
  originalAmount: Decimal;
  currency: string;
  dueDate: string;
}

export interface AssessContext {
  businessDate: string;
  now: Date;
  fxMaxAgeMs: number;
}

export type DeclineCode =
  | 'INVOICE_PAST_DUE'
  | 'PROGRAM_SUSPENDED'
  | 'PROGRAM_CLOSED'
  | 'PROGRAM_ON_HOLD'
  | 'FX_RATE_UNAVAILABLE'
  | 'FX_RATE_SUSPENDED'
  | 'FX_RATE_STALE'
  | 'INSUFFICIENT_CAPACITY';

export type Assessment =
  | { outcome: 'decline'; code: DeclineCode; amount?: Decimal; fx?: FxQuote }
  | { outcome: 'reserve'; amount: Decimal; fx?: FxQuote };

export interface Availability {
  available: Decimal;
  overLimit: Decimal;
}