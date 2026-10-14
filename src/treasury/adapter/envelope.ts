import { isIdentifier } from '../../shared/domain/identifier.js';
import { ISO_INSTANT } from '../../shared/time/instant.js';
import type { Envelope, EnvelopeResult, ParsedValue, RawMessage } from './envelope.types.js';
const MAX_VERSION = 2n ** 63n - 1n;

export function parseInstant(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function parseVersion(value: unknown): bigint | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value)) {
    const version = BigInt(value);
    return version <= MAX_VERSION ? version : undefined;
  }
  return undefined;
}

function parseWithoutNul(value: string): ParsedValue {
  let nul = false;
  const json: unknown = JSON.parse(value, (key, item: unknown) => {
    if (key.includes('\0') || (typeof item === 'string' && item.includes('\0'))) nul = true;
    return item;
  });
  return { json, nul };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseEnvelope(raw: RawMessage): EnvelopeResult {
  if (raw.value === null) return { kind: 'unreadable', reason: 'empty value' };

  let parsed: ParsedValue;
  try {
    parsed = parseWithoutNul(raw.value);
  } catch {
    return { kind: 'unreadable', reason: 'value is not JSON' };
  }
  if (parsed.nul) return { kind: 'unreadable', reason: 'value contains a NUL character' };
  const json = parsed.json;
  if (!isObject(json)) return { kind: 'unreadable', reason: 'value is not an object' };

  const asOf = parseInstant(json.asOf);
  if (!isIdentifier(json.messageId)) return { kind: 'unreadable', reason: 'messageId is missing or invalid' };
  if (typeof json.type !== 'string' || json.type.length === 0 || json.type.length > 64) {
    return { kind: 'unreadable', reason: 'type is missing or invalid' };
  }
  if (!Number.isSafeInteger(json.schemaVersion)) return { kind: 'unreadable', reason: 'schemaVersion is missing or invalid' };
  if (!asOf) return { kind: 'unreadable', reason: 'asOf is missing or invalid' };

  const programId = isIdentifier(json.programId) ? json.programId : undefined;
  const batchId = isIdentifier(json.batchId) ? json.batchId : undefined;

  return {
    kind: 'readable',
    envelope: {
      messageId: json.messageId,
      type: json.type,
      schemaVersion: json.schemaVersion as number,
      programId,
      batchId,
      version: parseVersion(json.version),
      asOf,
      payload: isObject(json.payload) ? json.payload : {},
    },
  };
}

export function serializeEnvelope(envelope: Envelope): string {
  return JSON.stringify({
    ...envelope,
    version: envelope.version?.toString(),
    asOf: envelope.asOf.toISOString(),
  });
}