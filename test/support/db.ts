import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import type { ProgramSeed, RateSeed } from './support.types.js';

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: inject('databaseUrls').app, max: 4 });
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export const unique = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export async function seedProgram(seed: ProgramSeed = {}): Promise<string> {
  const externalId = unique('P');
  await db().query(
    `INSERT INTO program (external_id, client_ref, currency, credit_limit, external_utilized, status, open_blocking_breaks, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [
      externalId,
      seed.clientRef ?? 'C-ACME',
      seed.currency ?? 'EUR',
      seed.creditLimit ?? '1000',
      seed.externalUtilized ?? '0',
      seed.status ?? 'ACTIVE',
      seed.openBlockingBreaks ?? 0,
    ],
  );
  return externalId;
}

let rateVersion = Date.now() * 1000;

export async function seedRate(seed: RateSeed): Promise<string> {
  const rateId = unique('R');
  const messageId = unique('m');
  const asOf = new Date(Date.now() - (seed.ageSeconds ?? 60) * 1000);
  await db().query(
    `INSERT INTO processed_message (message_id, type, outcome, as_of, kafka_timestamp, topic, partition, "offset")
     VALUES ($1, 'FX_RATE_PUBLISHED', 'APPLIED', $2, $2, 'treasury.fx-rates', 0, 0)`,
    [messageId, asOf],
  );
  await db().query(
    `INSERT INTO fx_rate (external_id, from_currency, to_currency, rate_type, version, rate, status, as_of, kafka_timestamp, message_id)
     VALUES ($1, $2, $3, 'VALUATION', $4, $5, $6, $7, $7, $8)`,
    [
      rateId,
      seed.from,
      seed.to,
      ++rateVersion,
      seed.status === 'SUSPENDED' ? null : (seed.rate ?? '1'),
      seed.status ?? 'ACTIVE',
      asOf,
      messageId,
    ],
  );
  return rateId;
}