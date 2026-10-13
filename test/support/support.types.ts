import type { JWTPayload } from 'jose';
import type { StartedTestContainer } from 'testcontainers';

export interface ProgramSeed {
  currency?: string;
  creditLimit?: string;
  externalUtilized?: string;
  status?: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  clientRef?: string;
  openBlockingBreaks?: number;
}

export interface RateSeed {
  from: string;
  to: string;
  rate?: string;
  status?: 'ACTIVE' | 'SUSPENDED';
  ageSeconds?: number;
}

export interface TokenOptions {
  claims?: JWTPayload & Record<string, unknown>;
  issuer?: string;
  audience?: string;
  expiresIn?: string | number;
  foreignKey?: boolean;
}

export interface StartedKafka {
  container: StartedTestContainer;
  brokers: string;
  stop(): Promise<void>;
}

export interface ReceivedMessage {
  key: string | null;
  value: string;
  headers: Record<string, string>;
}

export interface ProgramMessageInput {
  type: string;
  programId?: string;
  version?: number | string;
  payload?: Record<string, unknown>;
  messageId?: string;
  asOf?: string;
  brokerTime?: Date;
  schemaVersion?: number;
}

export type GuardCase = [name: string, sql: string, expected: 'ok' | string];

export interface QuoteInput {
  rateId?: string;
  from?: string;
  to?: string;
  rateType?: string;
  status?: string;
  rate?: string | null;
  version?: bigint;
  messageId?: string;
  ageSeconds?: number;
}