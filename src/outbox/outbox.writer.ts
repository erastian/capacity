import type { Tx } from '../shared/db/prisma.service.js';
import type { OutboundEvent } from './outbox.types.js';

export const OUTBOUND_SCHEMA_VERSION = 1;

export async function writeOutbox(tx: Tx, event: OutboundEvent): Promise<void> {
  const payload = {
    schemaVersion: OUTBOUND_SCHEMA_VERSION,
    type: event.type,
    occurredAt: event.occurredAt.toISOString(),
    correlationId: event.correlationId,
    data: event.data,
  };
  await tx.$executeRaw`
    INSERT INTO outbox_event (type, program_id, partition_key, payload)
    VALUES (${event.type}::"OutboundEventType", ${event.programId}::uuid, ${event.partitionKey}, ${JSON.stringify(payload)}::jsonb)
  `;
}
