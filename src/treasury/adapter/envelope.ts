import { isIdentifier } from '../../shared/domain/identifier.js';
import type { EnvelopeResult, RawMessage } from './envelope.types.js';

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function parseInstant(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function parseVersion(value: unknown): bigint | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9]\d{0,18})$/.test(value)) return BigInt(value);
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseEnvelope(raw: RawMessage): EnvelopeResult {
  if (raw.value === null) return { kind: 'unreadable', reason: 'empty value' };

  let json: unknown;
  try {
    json = JSON.parse(raw.value);
  } catch {
    return { kind: 'unreadable', reason: 'value is not JSON' };
  }
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