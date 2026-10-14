import type { ProgramScope } from '../shared/auth/visibility.types.js';
import type { Numeric } from '../shared/db/db.types.js';

export interface Viewer {
  scope: ProgramScope;
  seesBreaks: boolean;
  seesFundingRef: boolean;
}

export type ReservationStatus = 'ACTIVE' | 'PARTIALLY_RELEASED' | 'RELEASED' | 'CANCELLED';

export type MovementKind = 'REPAYMENT' | 'WRITE_OFF' | 'CANCELLATION' | 'REVERSAL';

export interface Amount {
  amount: string;
  currency: string;
}

export interface ReservationRow {
  id: string;
  program_id: string;
  client_ref: string;
  invoice_id: string;
  status: ReservationStatus;
  original_amount: Numeric;
  original_currency: string;
  amount: Numeric;
  currency: string;
  fx_rate_id: string | null;
  due_date: string;
  released_original_amount: Numeric;
  released_amount: Numeric;
  funded_at: Date | null;
  funding_ref: string | null;
  created_at: Date;
}

export interface ReservationView {
  id: string;
  programId: string;
  invoiceId: string;
  status: ReservationStatus;
  original: Amount;
  capacity: Amount;
  fxRateId: string | null;
  dueDate: string;
  outstanding: Amount;
  capacityOutstanding: Amount;
  funding: { fundedAt: string; fundingRef?: string } | null;
  createdAt: string;
}

export interface MovementRow {
  id: string;
  reason: MovementKind;
  external_ref: string;
  original_amount: Numeric;
  amount: Numeric;
  payment_id: string | null;
  payment_amount: Numeric | null;
  payment_currency: string | null;
  payment_rate_id: string | null;
  payment_rate: Numeric | null;
  cancellation_reason: string | null;
  write_off_reason: string | null;
  reverses_external_ref: string | null;
  as_of: Date;
  created_at: Date;
}

export interface MovementView {
  id: string;
  kind: MovementKind;
  externalRef: string;
  amount: Amount;
  capacity: Amount;
  payment?: { id: string; amount: Amount; fx: { rateId: string; rate: string } | null };
  reason?: string;
  reverses?: string;
  outstandingAfter: Amount;
  asOf: string;
  recordedAt: string;
}

export interface PendingRow {
  message_id: string;
  type: string;
  awaiting_kind: string;
  awaiting_ref: string;
  payload: Record<string, unknown>;
  parked_at: Date;
}

export interface PendingView {
  messageId: string;
  type: string;
  externalRef: string | null;
  amount: Amount | null;
  payment: Amount | null;
  awaiting: { kind: string; ref: string };
  since: string;
}

export interface BreakRow {
  id: string;
  reason: string;
  blocking: boolean;
  opened_at: Date;
  resolved_at: Date | null;
  details: Record<string, unknown>;
}

export interface BreakSummary {
  id: string;
  reason: string;
  blocking: boolean;
  openedAt: string;
  resolvedAt: string | null;
  details: Record<string, unknown>;
}

export interface ReservationCard extends ReservationView {
  movements: MovementView[];
  pending: PendingView[];
  breaks?: BreakSummary[];
}

export interface PayoffQuote {
  reservationId: string;
  invoiceId: string;
  outstanding: Amount;
  payoff: Amount;
  fx: { rateId: string; rate: string; asOf: string } | null;
  quotedAt: string;
}

export interface DeclineRow {
  id: string;
  program_id: string;
  invoice_id: string;
  requested_amount: Numeric;
  requested_currency: string;
  code: string;
  details: Record<string, unknown>;
  correlation_id: string;
  created_at: Date;
}

export interface DeclineView {
  id: string;
  programId: string;
  invoiceId: string;
  requested: Amount;
  code: string;
  details: Record<string, unknown>;
  correlationId: string;
  createdAt: string;
}

export interface ReservationFilter {
  programId?: string;
  invoiceId?: string;
  status?: ReservationStatus;
}