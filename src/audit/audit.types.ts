import type { Numeric } from '../shared/db/db.types.js';

export interface BreakRow {
  id: string;
  program_id: string;
  reservation_id: string | null;
  invoice_id: string | null;
  reason: string;
  blocking: boolean;
  details: Record<string, unknown>;
  message_id: string;
  opened_at: Date;
  resolved_at: Date | null;
  resolution_message_id: string | null;
}

export interface BreakView {
  id: string;
  programId: string;
  reservationId: string | null;
  invoiceId: string | null;
  reason: string;
  blocking: boolean;
  details: Record<string, unknown>;
  messageId: string;
  openedAt: string;
  resolvedAt: string | null;
  resolutionMessageId: string | null;
}

export interface BreakFilter {
  programId?: string;
  open?: boolean;
  reason?: string;
}

export interface LedgerRow {
  id: Numeric;
  type: string;
  credit_limit_delta: Numeric;
  external_utilized_delta: Numeric;
  reserved_delta: Numeric;
  credit_limit_after: Numeric;
  external_utilized_after: Numeric;
  reserved_after: Numeric;
  reservation_id: string | null;
  release_id: string | null;
  message_id: string | null;
  created_at: Date;
}

export interface LedgerView {
  id: string;
  type: string;
  delta: { creditLimit: string; externalUtilized: string; reserved: string };
  after: { creditLimit: string; externalUtilized: string; reserved: string };
  currency: string;
  reservationId: string | null;
  releaseId: string | null;
  messageId: string | null;
  createdAt: string;
}

export interface InboxRow {
  message_id: string;
  type: string | null;
  outcome: string;
  reason: string | null;
  program_external_id: string | null;
  batch_id: string | null;
  version: Numeric | null;
  as_of: Date;
  kafka_timestamp: Date;
  topic: string;
  partition: number;
  offset: Numeric;
  processed_at: Date;
}

export interface InboxView {
  messageId: string;
  type: string | null;
  outcome: string;
  reason: string | null;
  programId: string | null;
  batchId: string | null;
  version: string | null;
  asOf: string;
  kafkaTimestamp: string;
  coordinates: { topic: string; partition: number; offset: string };
  processedAt: string;
}

export interface InboxFilter {
  programId?: string;
  messageId?: string;
  outcome?: string;
  type?: string;
}

export interface ParkedRow {
  message_id: string;
  type: string;
  program_external_id: string;
  reservation_id: string | null;
  awaiting_kind: string;
  awaiting_ref: string;
  envelope: Record<string, unknown>;
  topic: string;
  partition: number;
  offset: Numeric;
  parked_at: Date;
  resolved_at: Date | null;
}

export interface ParkedView {
  messageId: string;
  type: string;
  programId: string;
  reservationId: string | null;
  awaiting: { kind: string; ref: string };
  envelope: Record<string, unknown>;
  coordinates: { topic: string; partition: number; offset: string };
  parkedAt: string;
  resolvedAt: string | null;
}

export interface ParkedFilter {
  programId?: string;
  unresolved?: boolean;
}

export interface FundingRow {
  id: string;
  funding_ref: string;
  funded_at: Date;
  message_id: string;
  returned_at: Date | null;
  return_message_id: string | null;
  created_at: Date;
}

export interface FundingView {
  fundingRef: string;
  fundedAt: string;
  messageId: string;
  returnedAt: string | null;
  returnMessageId: string | null;
}

export interface OutboxRow {
  id: Numeric;
  event_id: string;
  type: string;
  partition_key: string;
  payload: Record<string, unknown>;
  created_at: Date;
  published_at: Date | null;
}

export interface OutboxView {
  eventId: string;
  type: string;
  partitionKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
  publishedAt: string | null;
}

export interface OutboxFilter {
  unpublished?: boolean;
  programId?: string;
  type?: string;
}

export interface DeclineJournalRow {
  id: string;
  program_id: string;
  invoice_id: string;
  requested_amount: Numeric;
  requested_currency: string;
  code: string;
  details: Record<string, unknown>;
  created_by: string;
  correlation_id: string;
  created_at: Date;
}

export interface DeclineJournalView {
  id: string;
  programId: string;
  invoiceId: string;
  requested: { amount: string; currency: string };
  code: string;
  details: Record<string, unknown>;
  createdBy: string;
  correlationId: string;
  createdAt: string;
}

export interface DeclineFilter {
  programId?: string;
  code?: string;
  from?: string;
  to?: string;
}
