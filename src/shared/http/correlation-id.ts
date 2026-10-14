import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const CORRELATION_HEADER = 'x-correlation-id';

const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;
const ZERO_TRACE_ID = '0'.repeat(32);

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

export function resolveCorrelationId(headers: IncomingHttpHeaders): string {
  const explicit = single(headers[CORRELATION_HEADER]);
  if (explicit && CORRELATION_ID.test(explicit)) {
    return explicit;
  }

  const traceId = TRACEPARENT.exec(single(headers.traceparent) ?? '')?.[1];
  if (traceId && traceId !== ZERO_TRACE_ID) {
    return traceId;
  }

  return randomUUID();
}
