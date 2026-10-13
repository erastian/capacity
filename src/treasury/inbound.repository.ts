import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import type { Numeric } from '../shared/db/db.types.js';
import type { Tx } from '../shared/db/prisma.service.js';
import type { FxRatePublished } from './adapter/commands.types.js';
import type { Envelope } from './adapter/envelope.types.js';
import type { StoredQuote } from './domain/fx-rate-decision.types.js';
import type {
  Balances,
  BreakSpec,
  LedgerKind,
  NewProgram,
  ProgramChanges,
  ProgramView,
} from './domain/program-decision.types.js';
import type {
  FxRateRow,
  InboxRecord,
  KafkaCoordinates,
  Outcome,
  ParkedRecord,
  ParkedRow,
  ProgramRow,
} from './inbound.types.js';

const FX_COLUMNS = `external_id, from_currency, to_currency, rate_type::text AS rate_type, version,
  status::text AS status, rate`;

function toQuote(row: FxRateRow): StoredQuote {
  return {
    rateId: row.external_id,
    from: row.from_currency,
    to: row.to_currency,
    rateType: row.rate_type,
    version: BigInt(row.version.toString()),
    status: row.status,
    rate: row.rate === null ? undefined : new Decimal(row.rate.toString()),
  };
}

const dec = (value: Numeric) => new Decimal(value.toString());
const big = (value: Numeric | null) => (value === null ? null : BigInt(value.toString()));

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

const PROGRAM_COLUMNS = `id, external_id, client_ref, currency, credit_limit, credit_limit_version,
  external_utilized, external_utilized_version, reserved, status::text AS status, status_reason, status_version`;

const PARKED_COLUMNS = `message_id, type::text AS type, awaiting_kind::text AS awaiting_kind, awaiting_ref,
  envelope, topic, partition, "offset", kafka_timestamp, resolved_at`;

function toProgram(row: ProgramRow): ProgramView {
  return {
    id: row.id,
    externalId: row.external_id,
    clientRef: row.client_ref,
    currency: row.currency,
    creditLimit: dec(row.credit_limit),
    creditLimitVersion: big(row.credit_limit_version),
    externalUtilized: dec(row.external_utilized),
    externalUtilizedVersion: big(row.external_utilized_version),
    reserved: dec(row.reserved),
    status: row.status,
    statusReason: row.status_reason,
    statusVersion: big(row.status_version),
  };
}

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

@Injectable()
export class InboundRepository {
  async lockProgram(tx: Tx, externalId: string): Promise<ProgramView | undefined> {
    const rows = await tx.$queryRawUnsafe<ProgramRow[]>(
      `SELECT ${PROGRAM_COLUMNS} FROM program WHERE external_id = $1 FOR UPDATE`,
      externalId,
    );
    return rows[0] && toProgram(rows[0]);
  }

  async findInbox(tx: Tx, messageId: string): Promise<InboxRecord | undefined> {
    const rows = await tx.$queryRaw<{ outcome: Outcome; reason: string | null; program_id: string | null }[]>`
      SELECT outcome::text AS outcome, reason, program_id FROM processed_message WHERE message_id = ${messageId}
    `;
    const row = rows[0];
    return row && { outcome: row.outcome, reason: row.reason, programId: row.program_id };
  }

  async findParked(tx: Tx, messageId: string): Promise<ParkedRecord | undefined> {
    const rows = await tx.$queryRawUnsafe<ParkedRow[]>(
      `SELECT ${PARKED_COLUMNS} FROM parked_message WHERE message_id = $1`,
      messageId,
    );
    return rows[0] && toParked(rows[0]);
  }

  async lastUnresolvedParked(tx: Tx, programExternalId: string): Promise<string | undefined> {
    const rows = await tx.$queryRaw<{ message_id: string }[]>`
      SELECT message_id FROM parked_message
      WHERE program_external_id = ${programExternalId} AND resolved_at IS NULL
      ORDER BY partition DESC, "offset" DESC
      LIMIT 1
    `;
    return rows[0]?.message_id;
  }

  async nextUnresolvedParked(tx: Tx, programExternalId: string): Promise<ParkedRecord | undefined> {
    const rows = await tx.$queryRawUnsafe<ParkedRow[]>(
      `SELECT ${PARKED_COLUMNS} FROM parked_message
       WHERE program_external_id = $1 AND resolved_at IS NULL
       ORDER BY partition, "offset"
       LIMIT 1`,
      programExternalId,
    );
    return rows[0] && toParked(rows[0]);
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

  async insertParked(
    tx: Tx,
    record: Omit<ParkedRecord, 'resolvedAt'> & { programId: string | null; programExternalId: string },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO parked_message (
        message_id, type, program_id, program_external_id, awaiting_kind, awaiting_ref, envelope,
        kafka_timestamp, topic, partition, "offset"
      ) VALUES (
        ${record.messageId}, ${record.type}::"InboundMessageType", ${record.programId}::uuid,
        ${record.programExternalId}, ${record.awaitingKind}::"AwaitingKind", ${record.awaitingRef},
        ${serializeEnvelope(record.envelope)}::jsonb, ${record.coordinates.timestamp},
        ${record.coordinates.topic}, ${record.coordinates.partition}, ${record.coordinates.offset}
      )
    `;
  }

  async findQuoteByRateId(tx: Tx, rateId: string): Promise<StoredQuote | undefined> {
    const rows = await tx.$queryRawUnsafe<FxRateRow[]>(
      `SELECT ${FX_COLUMNS} FROM fx_rate WHERE external_id = $1`,
      rateId,
    );
    return rows[0] && toQuote(rows[0]);
  }

  async findQuoteByPairVersion(tx: Tx, quote: FxRatePublished): Promise<StoredQuote | undefined> {
    const rows = await tx.$queryRawUnsafe<FxRateRow[]>(
      `SELECT ${FX_COLUMNS} FROM fx_rate
       WHERE from_currency = $1 AND to_currency = $2 AND rate_type = $3::"FxRateType" AND version = $4`,
      quote.from,
      quote.to,
      quote.rateType,
      quote.version,
    );
    return rows[0] && toQuote(rows[0]);
  }

  async insertQuote(tx: Tx, quote: FxRatePublished, envelope: Envelope, coordinates: KafkaCoordinates): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO fx_rate (external_id, from_currency, to_currency, rate_type, version, rate, status, as_of, kafka_timestamp, message_id)
      VALUES (
        ${quote.rateId}, ${quote.from}, ${quote.to}, ${quote.rateType}::"FxRateType", ${quote.version},
        ${quote.rate?.toString() ?? null}::numeric, ${quote.status}::"FxRateStatus", ${envelope.asOf},
        ${coordinates.timestamp}, ${envelope.messageId}
      )
    `;
  }

  async quoteExists(tx: Tx, rateId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM fx_rate WHERE external_id = ${rateId}) AS exists
    `;
    return rows[0]?.exists ?? false;
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

  async createProgram(tx: Tx, program: NewProgram, effectiveAsOf: Date): Promise<ProgramView> {
    const rows = await tx.$queryRawUnsafe<ProgramRow[]>(
      `INSERT INTO program (
         external_id, client_ref, currency, credit_limit, credit_limit_version, external_utilized,
         external_utilized_version, status, status_reason, status_version, status_changed_at,
         treasury_synced_at, updated_at
       ) VALUES ($1, $2, $3, $4::numeric, $5, $6::numeric, $7, $8::"ProgramStatus", $9, $10, $11, $11, now())
       RETURNING ${PROGRAM_COLUMNS}`,
      program.externalId,
      program.clientRef,
      program.currency,
      program.creditLimit.amount.toString(),
      program.creditLimit.version,
      program.externalUtilized.amount.toString(),
      program.externalUtilized.version,
      program.status.value,
      program.status.reason,
      program.status.version,
      effectiveAsOf,
    );
    return toProgram(rows[0]!);
  }

  async updateProgram(tx: Tx, before: ProgramView, changes: ProgramChanges, effectiveAsOf: Date): Promise<ProgramView> {
    const statusChanged = changes.status !== undefined && changes.status.value !== before.status;
    const rows = await tx.$queryRawUnsafe<ProgramRow[]>(
      `UPDATE program SET
         credit_limit = $2::numeric, credit_limit_version = $3,
         external_utilized = $4::numeric, external_utilized_version = $5,
         status = $6::"ProgramStatus", status_reason = $7, status_version = $8,
         status_changed_at = CASE WHEN $9 THEN $10::timestamptz ELSE status_changed_at END,
         treasury_synced_at = greatest(treasury_synced_at, $10::timestamptz),
         updated_at = now()
       WHERE id = $1::uuid
       RETURNING ${PROGRAM_COLUMNS}`,
      before.id,
      (changes.creditLimit?.amount ?? before.creditLimit).toString(),
      changes.creditLimit?.version ?? before.creditLimitVersion,
      (changes.externalUtilized?.amount ?? before.externalUtilized).toString(),
      changes.externalUtilized?.version ?? before.externalUtilizedVersion,
      changes.status?.value ?? before.status,
      changes.status ? changes.status.reason : before.statusReason,
      changes.status?.version ?? before.statusVersion,
      statusChanged,
      effectiveAsOf,
    );
    return toProgram(rows[0]!);
  }

  async touchSyncedAt(tx: Tx, programId: string, effectiveAsOf: Date): Promise<void> {
    await tx.$executeRaw`
      UPDATE program
      SET treasury_synced_at = greatest(treasury_synced_at, ${effectiveAsOf}::timestamptz), updated_at = now()
      WHERE id = ${programId}::uuid
    `;
  }

  async insertTreasuryLedger(
    tx: Tx,
    programId: string,
    kind: LedgerKind,
    before: Balances,
    after: Balances,
    messageId: string,
  ): Promise<boolean> {
    const creditDelta = after.creditLimit.minus(before.creditLimit);
    const utilizedDelta = after.externalUtilized.minus(before.externalUtilized);
    if (creditDelta.isZero() && utilizedDelta.isZero()) return false;

    const type =
      kind === 'TREASURY_SNAPSHOT'
        ? 'TREASURY_SNAPSHOT'
        : creditDelta.isZero()
          ? 'TREASURY_EXTERNAL_UTILIZATION_UPDATED'
          : 'TREASURY_LIMIT_UPDATED';

    await tx.$executeRaw`
      INSERT INTO capacity_ledger (
        program_id, type, credit_limit_delta, external_utilized_delta, reserved_delta,
        credit_limit_after, external_utilized_after, reserved_after, message_id
      ) VALUES (
        ${programId}::uuid, ${type}::"LedgerEntryType", ${creditDelta.toString()}::numeric,
        ${utilizedDelta.toString()}::numeric, 0, ${after.creditLimit.toString()}::numeric,
        ${after.externalUtilized.toString()}::numeric, ${after.reserved.toString()}::numeric, ${messageId}
      )
    `;
    return true;
  }

  async openBreak(
    tx: Tx,
    spec: BreakSpec,
    program: { id: string } | undefined,
    programExternalId: string,
    messageId: string,
  ): Promise<{ id: string; created: boolean }> {
    const essence = JSON.stringify(spec.essence);
    const existing = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM program_break
      WHERE resolved_at IS NULL
        AND reason = ${spec.reason}::"BreakReason"
        AND details -> 'essence' @> ${essence}::jsonb
        AND (program_id = ${program?.id ?? null}::uuid
             OR (${program?.id ?? null}::uuid IS NULL AND program_id IS NULL AND program_external_id = ${programExternalId}))
      LIMIT 1
    `;
    if (existing[0]) return { id: existing[0].id, created: false };

    const blocking = program ? spec.blocking : false;
    const details = JSON.stringify({ ...spec.details, essence: spec.essence });
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO program_break (program_id, program_external_id, reason, blocking, message_id, details)
      VALUES (
        ${program?.id ?? null}::uuid, ${program ? null : programExternalId}, ${spec.reason}::"BreakReason",
        ${blocking}, ${messageId}, ${details}::jsonb
      )
      RETURNING id
    `;
    if (blocking && program) {
      await tx.$executeRaw`
        UPDATE program SET open_blocking_breaks = open_blocking_breaks + 1, updated_at = now()
        WHERE id = ${program.id}::uuid
      `;
    }
    return { id: rows[0]!.id, created: true };
  }
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