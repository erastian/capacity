import type { Numeric } from '../shared/db/db.types.js';
import type { ProgramStatus } from '../shared/domain/program.types.js';
import type { Envelope } from './adapter/envelope.types.js';
import type { AnyBreakReason } from './domain/break-closure.types.js';
import type { ReleaseReason, ReservationStatus } from './domain/invoice-decision.types.js';

export type Outcome = 'APPLIED' | 'STALE' | 'REJECTED';

export type AwaitingKind = 'FX_RATE' | 'PROGRAM' | 'PRECEDING_MESSAGE';

export interface KafkaCoordinates {
  topic: string;
  partition: number;
  offset: bigint;
  timestamp: Date;
}

export interface InboxRecord {
  outcome: Outcome;
  reason: string | null;
  programId: string | null;
}

export interface ParkedRecord {
  messageId: string;
  type: string;
  awaitingKind: AwaitingKind;
  awaitingRef: string;
  envelope: Envelope;
  coordinates: KafkaCoordinates;
  resolvedAt: Date | null;
}

export interface ProgramRow {
  id: string;
  external_id: string;
  client_ref: string;
  currency: string;
  credit_limit: Numeric;
  credit_limit_version: Numeric | null;
  external_utilized: Numeric;
  external_utilized_version: Numeric | null;
  reserved: Numeric;
  status: ProgramStatus;
  status_reason: string | null;
  status_version: Numeric | null;
}

export interface ParkedRow {
  message_id: string;
  type: string;
  awaiting_kind: AwaitingKind;
  awaiting_ref: string;
  envelope: Record<string, unknown>;
  topic: string;
  partition: number;
  offset: Numeric;
  kafka_timestamp: Date;
  resolved_at: Date | null;
}

export interface Decision {
  deadLetter?: string;
  wake?: string;
  wakeRate?: string;
  parked?: boolean;
  batch?: string;
}

export interface FxRateRow {
  external_id: string;
  from_currency: string;
  to_currency: string;
  rate_type: 'VALUATION' | 'CONVERSION';
  version: Numeric;
  status: 'ACTIVE' | 'SUSPENDED';
  rate: Numeric | null;
}

export interface ReservationRow {
  id: string;
  program_id: string;
  program_external_id: string;
  invoice_id: string;
  original_amount: Numeric;
  original_currency: string;
  amount: Numeric;
  released_original_amount: Numeric;
  released_amount: Numeric;
  status: ReservationStatus;
  funding_ref: string | null;
  valuation_rate: Numeric | null;
}

export interface ReleaseRow {
  id: string;
  reason: ReleaseReason;
  external_ref: string;
  original_amount: Numeric;
  payment_id: string | null;
  payment_amount: Numeric | null;
  payment_currency: string | null;
  payment_rate_id: string | null;
  cancellation_reason: string | null;
  write_off_reason: string | null;
  reverses_external_ref: string | null;
  reversed: boolean;
}

export interface FundingRow {
  reservation_id: string;
  returned: boolean;
}

export interface BreakRow {
  id: string;
  reason: AnyBreakReason;
  blocking: boolean;
  program_id: string | null;
  reservation_id: string | null;
  message_id: string;
  resolved_at: Date | null;
  details: Record<string, unknown>;
}

export interface BatchProgress {
  batchId: string;
  programCount: number;
  received: number;
  alertedAt: Date | null;
}

export interface BatchProgressRow {
  batch_id: string;
  program_count: number;
  received: number;
  alerted_at: Date | null;
}

export interface ProcessingContext {
  envelope: Envelope;
  coordinates: KafkaCoordinates;
  partitionKey: string;
  fromParked: boolean;
}

export type StatusCode = 'ACCP' | 'RJCT' | 'PDNG';

export interface StatusReport {
  messageId: string;
  status: StatusCode;
  reason?: string | null;
  awaiting?: { kind: string; ref: string };
  references?: Record<string, string>;
  programId: string | null;
  partitionKey: string;
  correlationId: string;
  decidedAt: Date;
}
