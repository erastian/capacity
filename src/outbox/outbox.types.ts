export type OutboundEventType =
  | 'RESERVATION_CREATED'
  | 'RESERVATION_DECLINED'
  | 'RESERVATION_RELEASED'
  | 'RESERVATION_CANCELLED'
  | 'RESERVATION_RELEASE_REVERSED'
  | 'PROGRAM_BREAK_OPENED'
  | 'PROGRAM_BREAK_RESOLVED'
  | 'PROGRAM_LIMIT_EXCESS_STARTED'
  | 'PROGRAM_LIMIT_EXCESS_ENDED'
  | 'INBOUND_MESSAGE_STATUS';

export interface OutboundEvent {
  type: OutboundEventType;
  programId: string | null;
  partitionKey: string;
  correlationId: string;
  occurredAt: Date;
  data: Record<string, unknown>;
}

export interface OutgoingMessage {
  topic: string;
  key: string;
  value: string;
  headers: Record<string, string>;
}

export interface OutboxRow {
  id: string;
  event_id: string;
  type: string;
  partition_key: string;
  payload: Record<string, unknown>;
}