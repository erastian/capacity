import { Injectable } from '@nestjs/common';
import type { Decimal } from 'decimal.js';
import type { Numeric } from '../shared/db/db.types.js';
import { toDecimal as dec } from '../shared/db/numeric.js';
import type { Tx } from '../shared/db/prisma.service.js';
import type { CapacityBalances } from '../shared/money/capacity.types.js';
import type { FxRatePublished } from './adapter/commands.types.js';
import type { Envelope } from './adapter/envelope.types.js';
import type { BreakView } from './domain/break-closure.types.js';
import type { StoredQuote } from './domain/fx-rate-decision.types.js';
import type {
  InvoiceBreak,
  NewRelease,
  ReservationBalances,
  ReservationView,
  StoredFunding,
  StoredRelease,
} from './domain/invoice-decision.types.js';
import type {
  BreakSpec,
  LedgerKind,
  NewProgram,
  ProgramChanges,
  ProgramView,
} from './domain/program-decision.types.js';
import type {
  AwaitingKind,
  BatchProgress,
  BreakRow,
  FundingRow,
  FxRateRow,
  InboxRecord,
  KafkaCoordinates,
  Outcome,
  ParkedRecord,
  ParkedRow,
  ProgramRow,
  ReleaseRow,
  ReservationRow,
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
    rate: row.rate === null ? undefined : dec(row.rate),
  };
}

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

const RESERVATION_COLUMNS = `r.id, r.program_id, p.external_id AS program_external_id, r.invoice_id, r.original_amount,
  r.original_currency, r.amount, r.released_original_amount, r.released_amount, r.status::text AS status, r.funding_ref,
  f.rate AS valuation_rate`;

const RESERVATION_FROM = `FROM reservation r
  JOIN program p ON p.id = r.program_id
  LEFT JOIN fx_rate f ON f.id = r.fx_rate_id`;

function toReservation(row: ReservationRow): ReservationView {
  return {
    id: row.id,
    programId: row.program_id,
    programExternalId: row.program_external_id,
    invoiceId: row.invoice_id,
    originalAmount: dec(row.original_amount),
    originalCurrency: row.original_currency,
    amount: dec(row.amount),
    releasedOriginalAmount: dec(row.released_original_amount),
    releasedAmount: dec(row.released_amount),
    status: row.status,
    fundingRef: row.funding_ref,
    valuationRate: row.valuation_rate === null ? undefined : dec(row.valuation_rate),
  };
}

function toRelease(row: ReleaseRow): StoredRelease {
  return {
    id: row.id,
    reason: row.reason,
    externalRef: row.external_ref,
    originalAmount: dec(row.original_amount),
    paymentId: row.payment_id,
    paymentAmount: row.payment_amount === null ? null : dec(row.payment_amount),
    paymentCurrency: row.payment_currency,
    paymentRateId: row.payment_rate_id,
    cancellationReason: row.cancellation_reason,
    writeOffReason: row.write_off_reason,
    reversesExternalRef: row.reverses_external_ref,
    reversed: row.reversed,
  };
}

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
    before: CapacityBalances,
    after: CapacityBalances,
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

  async findReservation(tx: Tx, invoiceId: string): Promise<ReservationView | undefined> {
    const rows = await tx.$queryRawUnsafe<ReservationRow[]>(
      `SELECT ${RESERVATION_COLUMNS} ${RESERVATION_FROM} WHERE r.invoice_id = $1`,
      invoiceId,
    );
    return rows[0] && toReservation(rows[0]);
  }

  async lockReservation(tx: Tx, id: string): Promise<ReservationView> {
    const rows = await tx.$queryRawUnsafe<ReservationRow[]>(
      `SELECT ${RESERVATION_COLUMNS} ${RESERVATION_FROM} WHERE r.id = $1::uuid FOR UPDATE OF r`,
      id,
    );
    return toReservation(rows[0]!);
  }

  async findRelease(tx: Tx, reservationId: string, externalRef: string): Promise<StoredRelease | undefined> {
    const rows = await tx.$queryRaw<ReleaseRow[]>`
      SELECT rr.id, rr.reason::text AS reason, rr.external_ref, rr.original_amount, rr.payment_id, rr.payment_amount,
             rr.payment_currency, q.external_id AS payment_rate_id, rr.cancellation_reason, rr.write_off_reason,
             t.external_ref AS reverses_external_ref,
             EXISTS (SELECT 1 FROM reservation_release x WHERE x.reverses_release_id = rr.id) AS reversed
      FROM reservation_release rr
      LEFT JOIN fx_rate q ON q.id = rr.payment_fx_rate_id
      LEFT JOIN reservation_release t ON t.id = rr.reverses_release_id
      WHERE rr.reservation_id = ${reservationId}::uuid AND rr.external_ref = ${externalRef}
    `;
    return rows[0] && toRelease(rows[0]);
  }

  async findFunding(tx: Tx, fundingRef: string): Promise<StoredFunding | undefined> {
    const rows = await tx.$queryRaw<FundingRow[]>`
      SELECT reservation_id, returned_at IS NOT NULL AS returned FROM reservation_funding WHERE funding_ref = ${fundingRef}
    `;
    const row = rows[0];
    return row && { reservationId: row.reservation_id, returned: row.returned };
  }

  async fund(tx: Tx, reservationId: string, fundingRef: string, fundedAt: Date, messageId: string): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO reservation_funding (reservation_id, funding_ref, funded_at, message_id)
      VALUES (${reservationId}::uuid, ${fundingRef}, ${fundedAt}, ${messageId})
    `;
    await tx.$executeRaw`
      UPDATE reservation SET funded_at = ${fundedAt}, funding_ref = ${fundingRef}, updated_at = now()
      WHERE id = ${reservationId}::uuid
    `;
  }

  async returnFunding(tx: Tx, reservationId: string, fundingRef: string, returnedAt: Date, messageId: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE reservation_funding SET returned_at = ${returnedAt}, return_message_id = ${messageId}
      WHERE reservation_id = ${reservationId}::uuid AND funding_ref = ${fundingRef} AND returned_at IS NULL
    `;
    await tx.$executeRaw`
      UPDATE reservation SET funded_at = NULL, funding_ref = NULL, updated_at = now()
      WHERE id = ${reservationId}::uuid AND funding_ref = ${fundingRef}
    `;
  }

  async insertRelease(tx: Tx, reservationId: string, release: NewRelease, messageId: string): Promise<string> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO reservation_release (
        reservation_id, reason, external_ref, payment_id, payment_amount, payment_currency, payment_fx_rate_id,
        cancellation_reason, write_off_reason, original_amount, amount, reverses_release_id, message_id
      ) VALUES (
        ${reservationId}::uuid, ${release.reason}::"ReleaseReason", ${release.externalRef}, ${release.paymentId},
        ${release.paymentAmount?.toString() ?? null}::numeric, ${release.paymentCurrency},
        (SELECT id FROM fx_rate WHERE external_id = ${release.paymentRateId}), ${release.cancellationReason},
        ${release.writeOffReason}, ${release.originalAmount.toString()}::numeric, ${release.amount.toString()}::numeric,
        ${release.reversesReleaseId}::uuid, ${messageId}
      )
      RETURNING id
    `;
    return rows[0]!.id;
  }

  async rebalanceReservation(tx: Tx, before: ReservationView, balances: ReservationBalances): Promise<void> {
    const updated = await tx.$executeRaw`
      UPDATE reservation SET
        released_original_amount = ${balances.releasedOriginalAmount.toString()}::numeric,
        released_amount = ${balances.releasedAmount.toString()}::numeric,
        status = ${balances.status}::"ReservationStatus",
        updated_at = now()
      WHERE id = ${before.id}::uuid
        AND released_original_amount = ${before.releasedOriginalAmount.toString()}::numeric
        AND status = ${before.status}::"ReservationStatus"
    `;
    if (updated !== 1) throw new Error(`Reservation ${before.id} changed while being rebalanced`);
  }

  async addReserved(tx: Tx, programId: string, delta: Decimal): Promise<ProgramView> {
    const rows = await tx.$queryRawUnsafe<ProgramRow[]>(
      `UPDATE program SET reserved = reserved + $2::numeric, updated_at = now()
       WHERE id = $1::uuid
       RETURNING ${PROGRAM_COLUMNS}`,
      programId,
      delta.toString(),
    );
    return toProgram(rows[0]!);
  }

  async insertReleaseLedger(
    tx: Tx,
    program: ProgramView,
    reservationId: string,
    releaseId: string,
    reversal: boolean,
    delta: Decimal,
    messageId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO capacity_ledger (
        program_id, type, reserved_delta, credit_limit_after, external_utilized_after, reserved_after,
        reservation_id, release_id, message_id
      ) VALUES (
        ${program.id}::uuid, ${reversal ? 'RELEASE_REVERSAL' : 'RELEASE'}::"LedgerEntryType", ${delta.toString()}::numeric,
        ${program.creditLimit.toString()}::numeric, ${program.externalUtilized.toString()}::numeric,
        ${program.reserved.toString()}::numeric, ${reservationId}::uuid, ${releaseId}::uuid, ${messageId}
      )
    `;
  }

  async findBreak(tx: Tx, breakId: string, program: ProgramView): Promise<BreakView | undefined> {
    const rows = await tx.$queryRaw<BreakRow[]>`
      SELECT id, reason::text AS reason, blocking, program_id, reservation_id, message_id, resolved_at, details
      FROM program_break
      WHERE id = ${breakId}::uuid
        AND (program_id = ${program.id}::uuid OR (program_id IS NULL AND program_external_id = ${program.externalId}))
    `;
    const row = rows[0];
    if (!row) return undefined;
    const { essence, ...details } = row.details as { essence?: Record<string, string> };
    return {
      id: row.id,
      reason: row.reason,
      blocking: row.blocking,
      programId: row.program_id,
      reservationId: row.reservation_id,
      messageId: row.message_id,
      resolvedAt: row.resolved_at,
      essence: essence ?? {},
      details,
    };
  }

  async laterMessageExists(tx: Tx, programId: string, openingMessageId: string, types: string[]): Promise<boolean> {
    const rows = await tx.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM processed_message m
        JOIN processed_message o ON o.message_id = ${openingMessageId}
        WHERE m.program_id = ${programId}::uuid
          AND m.type::text = ANY(${types}::text[])
          AND m.outcome IN ('APPLIED', 'STALE')
          AND m.topic = o.topic
          AND (m.partition, m."offset") > (o.partition, o."offset")
      ) AS exists
    `;
    return rows[0]?.exists ?? false;
  }

  async reversalApplied(tx: Tx, reservationId: string, externalRef: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM reservation_release rev
        JOIN reservation_release t ON t.id = rev.reverses_release_id
        WHERE t.reservation_id = ${reservationId}::uuid AND t.external_ref = ${externalRef}
      ) AS exists
    `;
    return rows[0]?.exists ?? false;
  }

  async cancellationReversedAfter(tx: Tx, reservationId: string, openingMessageId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM reservation_release rev
        JOIN reservation_release t ON t.id = rev.reverses_release_id
        JOIN processed_message m ON m.message_id = rev.message_id
        JOIN processed_message o ON o.message_id = ${openingMessageId}
        WHERE t.reservation_id = ${reservationId}::uuid
          AND t.reason = 'CANCELLATION'
          AND m.topic = o.topic
          AND (m.partition, m."offset") > (o.partition, o."offset")
      ) AS exists
    `;
    return rows[0]?.exists ?? false;
  }

  async closeBreak(tx: Tx, view: BreakView, messageId: string): Promise<void> {
    const closed = await tx.$executeRaw`
      UPDATE program_break SET resolved_at = now(), resolution_message_id = ${messageId}
      WHERE id = ${view.id}::uuid AND resolved_at IS NULL
    `;
    if (closed === 1 && view.blocking && view.programId !== null) {
      await tx.$executeRaw`
        UPDATE program SET open_blocking_breaks = open_blocking_breaks - 1, updated_at = now()
        WHERE id = ${view.programId}::uuid
      `;
    }
  }

  async findBatch(tx: Tx, batchId: string): Promise<{ programCount: number } | undefined> {
    const rows = await tx.$queryRaw<{ program_count: number }[]>`
      SELECT program_count FROM reconciliation_batch WHERE batch_id = ${batchId}
    `;
    return rows[0] && { programCount: rows[0].program_count };
  }

  async insertBatch(tx: Tx, batchId: string, programCount: number, messageId: string, deadlineAt: Date): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO reconciliation_batch (batch_id, program_count, completed_message_id, deadline_at)
      VALUES (${batchId}, ${programCount}, ${messageId}, ${deadlineAt})
    `;
  }

  async completeBatch(tx: Tx, batchId: string): Promise<BatchProgress | undefined> {
    const rows = await tx.$queryRaw<{ batch_id: string; program_count: number; received: number; alerted_at: Date | null }[]>`
      UPDATE reconciliation_batch b SET completed_at = now()
      FROM (
        SELECT count(DISTINCT program_external_id)::int AS received FROM processed_message
        WHERE batch_id = ${batchId} AND type = 'PROGRAM_SNAPSHOT'
      ) s
      WHERE b.batch_id = ${batchId} AND b.completed_at IS NULL AND s.received >= b.program_count
      RETURNING b.batch_id, b.program_count, s.received, b.alerted_at
    `;
    const row = rows[0];
    return row && { batchId: row.batch_id, programCount: row.program_count, received: row.received, alertedAt: row.alerted_at };
  }

  async flagOverdueBatches(tx: Tx): Promise<BatchProgress[]> {
    const rows = await tx.$queryRaw<{ batch_id: string; program_count: number; received: number; alerted_at: Date }[]>`
      UPDATE reconciliation_batch b SET alerted_at = now()
      WHERE b.completed_at IS NULL AND b.alerted_at IS NULL AND b.deadline_at < now()
      RETURNING b.batch_id, b.program_count, b.alerted_at, (
        SELECT count(DISTINCT m.program_external_id)::int FROM processed_message m
        WHERE m.batch_id = b.batch_id AND m.type = 'PROGRAM_SNAPSHOT'
      ) AS received
    `;
    return rows.map((row) => ({
      batchId: row.batch_id,
      programCount: row.program_count,
      received: row.received,
      alertedAt: row.alerted_at,
    }));
  }

  async openBreak(
    tx: Tx,
    spec: BreakSpec | InvoiceBreak,
    program: { id: string } | undefined,
    programExternalId: string,
    messageId: string,
  ): Promise<{ id: string; created: boolean }> {
    const reservationId = 'reservationId' in spec ? spec.reservationId : null;
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
      INSERT INTO program_break (program_id, program_external_id, reservation_id, reason, blocking, message_id, details)
      VALUES (
        ${program?.id ?? null}::uuid, ${program ? null : programExternalId}, ${reservationId}::uuid,
        ${spec.reason}::"BreakReason",
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