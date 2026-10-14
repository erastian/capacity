export interface RawMessage {
  topic: string;
  partition: number;
  offset: bigint;
  key: string | null;
  value: string | null;
  timestamp: Date;
}

export interface Envelope {
  messageId: string;
  type: string;
  schemaVersion: number;
  programId?: string;
  batchId?: string;
  version?: bigint;
  asOf: Date;
  payload: Record<string, unknown>;
}

export interface ParsedValue {
  json: unknown;
  nul: boolean;
}

export type EnvelopeResult = { kind: 'readable'; envelope: Envelope } | { kind: 'unreadable'; reason: string };
