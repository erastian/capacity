import type { RawMessage } from '../../src/treasury/adapter/envelope.types.js';
import { unique } from './db.js';
import type { ProgramMessageInput, QuoteInput } from './support.types.js';

let offset = 0n;
let quoteVersion = BigInt(Date.now()) * 1000n;

export const nextOffset = (): bigint => offset++;

export function programMessage(input: ProgramMessageInput): RawMessage & { messageId: string } {
  const messageId = input.messageId ?? unique('m');
  return {
    messageId,
    topic: 'treasury.program-capacity',
    partition: 0,
    offset: nextOffset(),
    key: input.key !== undefined ? input.key : (input.programId ?? input.batchId ?? null),
    value: JSON.stringify({
      messageId,
      type: input.type,
      schemaVersion: input.schemaVersion ?? 1,
      programId: input.programId,
      batchId: input.batchId,
      version: input.version,
      asOf: input.asOf ?? new Date(Date.now() - 1000).toISOString(),
      payload: input.payload ?? {},
    }),
    timestamp: input.brokerTime ?? new Date(),
  };
}

export function quoteMessage(input: QuoteInput = {}): RawMessage & { messageId: string; rateId: string } {
  const messageId = input.messageId ?? unique('m');
  const rateId = input.rateId ?? unique('R');
  const from = input.from ?? 'USD';
  const to = input.to ?? 'EUR';
  const rateType = input.rateType ?? 'VALUATION';
  const asOf = new Date(Date.now() - (input.ageSeconds ?? 1) * 1000);
  return {
    messageId,
    rateId,
    topic: 'treasury.fx-rates',
    partition: 0,
    offset: nextOffset(),
    key: `${from}:${to}:${rateType}`,
    value: JSON.stringify({
      messageId,
      type: 'FX_RATE_PUBLISHED',
      schemaVersion: 1,
      version: (input.version ?? ++quoteVersion).toString(),
      asOf: asOf.toISOString(),
      payload: {
        rateId,
        from,
        to,
        rateType,
        status: input.status ?? 'ACTIVE',
        ...(input.rate === null ? {} : { rate: input.rate ?? '0.92' }),
      },
    }),
    timestamp: asOf,
  };
}
