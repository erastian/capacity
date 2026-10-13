import type { Numeric } from '../shared/db/db.types.js';
import type { ProgramStatus } from '../shared/domain/program.types.js';
import type { Envelope } from './adapter/envelope.types.js';

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