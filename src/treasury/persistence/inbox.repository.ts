import { Injectable } from '@nestjs/common';
import type { Tx } from '../../shared/db/prisma.service.js';
import type { Envelope } from '../adapter/envelope.types.js';
import type { AwaitingKind, InboxRecord, KafkaCoordinates, Outcome, ParkedRecord, ParkedRow } from '../inbound.types.js';

export const KNOWN_TYPES = new Set([
  'LIMIT_UPDATED',
  'EXTERNAL_UTILIZATION_UPDATED',
  'PROGRAM_SNAPSHOT',
  'PROGRAM_STATUS_CHANGED',
  'RECONCILIATION_BATCH_COMPLETED',
  'INVOICE_FUNDED',
  'INVOICE_PAYMENT_ALLOCATED',
  'INVOICE_FUNDING_CANCELLED',
  'FX_RATE_PUBLISHED',
  'BREAK_RESOLVED',
  'INVOICE_RELEASE_REVERSED',
  'PROGRAM_REINSTATED',
  'INVOICE_FUNDING_RETURNED',
  'INVOICE_BALANCE_WRITTEN_OFF',
]);

const PARKED_COLUMNS = `message_id, type::text AS type, awaiting_kind::text AS awaiting_kind, awaiting_ref,
  envelope, topic, partition, "offset", kafka_timestamp, resolved_at`;

function serializeEnvelope(envelope: Envelope): string {
  return JSON.stringify({
    ...envelope,
    version: envelope.version?.toString(),
    asOf: envelope.asOf.toISOString(),
  });
}

function deserializeEnvelope(raw: Record<string, unknown>): Envelope {
  return {
    ...(raw as unknown as Envelope),
    version: raw.version === undefined ? undefined : BigInt(raw.version as string),
    asOf: new Date(raw.asOf as string),
  };
}

function toParked(row: ParkedRow): ParkedRecord {
  return {
    messageId: row.message_id,
    type: row.type,
    awaitingKind: row.awaiting_kind,
    awaitingRef: row.awaiting_ref,
    envelope: deserializeEnvelope(row.envelope),
    coordinates: {
      topic: row.topic,
      partition: row.partition,
      offset: BigInt(row.offset.toString()),
      timestamp: row.kafka_timestamp,
    },
    resolvedAt: row.resolved_at,
  };
}

@Injectable()
export class InboxRepository {
  async findInbox(tx: Tx, messageId: string): Promise<InboxRecord | undefined> {
    const rows = await tx.$queryRaw<{ outcome: Outcome; reason: string | null; program_id: string | null }[]>`
      SELECT outcome::text AS outcome, reason, program_id FROM processed_message WHERE message_id = ${messageId}
    `;
    const row = rows[0];
    return row && { outcome: row.outcome, reason: row.reason, programId: row.program_id };
  }

  async insertInbox(
    tx: Tx,
    envelope: Envelope,
    coordinates: KafkaCoordinates,
    record: InboxRecord & { type: string | null; programExternalId: string | null },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO processed_message (
        message_id, type, outcome, reason, program_id, program_external_id, batch_id, version,
        as_of, kafka_timestamp, topic, partition, "offset"
      ) VALUES (
        ${envelope.messageId}, ${record.type}::"InboundMessageType", ${record.outcome}::"InboundMessageOutcome",
        ${record.reason}, ${record.programId}::uuid, ${record.programExternalId}, ${envelope.batchId ?? null},
        ${envelope.version ?? null}, ${envelope.asOf}, ${coordinates.timestamp}, ${coordinates.topic},
        ${coordinates.partition}, ${coordinates.offset}
      )
    `;
  }

  async findParked(tx: Tx, messageId: string): Promise<ParkedRecord | undefined> {
    const rows = await tx.$queryRawUnsafe<ParkedRow[]>(
      `SELECT ${PARKED_COLUMNS} FROM parked_message WHERE message_id = $1`,
      messageId,
    );
    return rows[0] && toParked(rows[0]);
  }

  async lastUnresolvedParked(tx: Tx, programExternalId: string, reservationId: string | null): Promise<string | undefined> {
    const rows = await tx.$queryRaw<{ message_id: string }[]>`
      SELECT message_id FROM parked_message
      WHERE program_external_id = ${programExternalId} AND resolved_at IS NULL
        AND (reservation_id IS NULL OR reservation_id = ${reservationId}::uuid)
      ORDER BY partition DESC, "offset" DESC
      LIMIT 1
    `;
    return rows[0]?.message_id;
  }

  async nextResolvableParked(tx: Tx, programExternalId: string): Promise<ParkedRecord | undefined> {
    const rows = await tx.$queryRawUnsafe<ParkedRow[]>(
      `SELECT ${PARKED_COLUMNS} FROM parked_message pm
       WHERE pm.program_external_id = $1 AND pm.resolved_at IS NULL
         AND CASE pm.awaiting_kind
           WHEN 'PROGRAM' THEN EXISTS (SELECT 1 FROM program p WHERE p.external_id = pm.program_external_id)
           WHEN 'FX_RATE' THEN EXISTS (SELECT 1 FROM fx_rate f WHERE f.external_id = pm.awaiting_ref)
           ELSE NOT EXISTS (
             SELECT 1 FROM parked_message prev
             WHERE prev.program_external_id = pm.program_external_id AND prev.resolved_at IS NULL
               AND (prev.reservation_id IS NULL OR prev.reservation_id = pm.reservation_id)
               AND (prev.partition, prev."offset") < (pm.partition, pm."offset")
           )
         END
       ORDER BY pm.partition, pm."offset"
       LIMIT 1`,
      programExternalId,
    );
    return rows[0] && toParked(rows[0]);
  }

  async awaitAgain(tx: Tx, messageId: string, awaitingKind: AwaitingKind, awaitingRef: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE parked_message SET awaiting_kind = ${awaitingKind}::"AwaitingKind", awaiting_ref = ${awaitingRef}
      WHERE message_id = ${messageId}
    `;
  }

  async programsWithResolvableParked(tx: Tx): Promise<string[]> {
    const rows = await tx.$queryRaw<{ program_external_id: string }[]>`
      SELECT DISTINCT pm.program_external_id
      FROM parked_message pm
      JOIN program p ON p.external_id = pm.program_external_id
      WHERE pm.resolved_at IS NULL
    `;
    return rows.map((row) => row.program_external_id);
  }

  async insertParked(
    tx: Tx,
    record: Omit<ParkedRecord, 'resolvedAt'> & {
      programId: string | null;
      programExternalId: string;
      reservationId: string | null;
    },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO parked_message (
        message_id, type, program_id, program_external_id, reservation_id, awaiting_kind, awaiting_ref, envelope,
        kafka_timestamp, topic, partition, "offset"
      ) VALUES (
        ${record.messageId}, ${record.type}::"InboundMessageType", ${record.programId}::uuid,
        ${record.programExternalId}, ${record.reservationId}::uuid, ${record.awaitingKind}::"AwaitingKind",
        ${record.awaitingRef},
        ${serializeEnvelope(record.envelope)}::jsonb, ${record.coordinates.timestamp},
        ${record.coordinates.topic}, ${record.coordinates.partition}, ${record.coordinates.offset}
      )
    `;
  }

  async programsAwaitingRate(tx: Tx, rateId: string): Promise<string[]> {
    const rows = await tx.$queryRaw<{ program_external_id: string }[]>`
      SELECT DISTINCT program_external_id FROM parked_message
      WHERE resolved_at IS NULL AND awaiting_kind = 'FX_RATE' AND awaiting_ref = ${rateId}
    `;
    return rows.map((row) => row.program_external_id);
  }

  async markResolved(tx: Tx, messageId: string): Promise<void> {
    await tx.$executeRaw`UPDATE parked_message SET resolved_at = now() WHERE message_id = ${messageId}`;
  }
}