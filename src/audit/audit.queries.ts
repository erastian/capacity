import { HttpStatus, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { toDecimal } from '../shared/db/numeric.js';
import { PrismaService } from '../shared/db/prisma.service.js';
import { AppError } from '../shared/errors/app-error.js';
import { CURSOR_PART, decodeCursor, toPage } from '../shared/http/pagination.js';
import type { Page } from '../shared/http/pagination.types.js';
import { minorUnits } from '../shared/money/currency.js';
import { formatAmount, formatCapacity } from '../shared/money/money.js';
import type {
  BreakFilter,
  BreakRow,
  BreakView,
  DeclineFilter,
  DeclineJournalRow,
  DeclineJournalView,
  FundingRow,
  FundingView,
  InboxFilter,
  InboxRow,
  InboxView,
  LedgerRow,
  LedgerView,
  OutboxFilter,
  OutboxRow,
  OutboxView,
  ParkedFilter,
  ParkedRow,
  ParkedView,
} from './audit.types.js';

const TIME_AND_UUID = [CURSOR_PART.instant, CURSOR_PART.uuid];
const TIME_AND_TEXT = [CURSOR_PART.instant, CURSOR_PART.text];

const iso = (value: Date | null) => value?.toISOString() ?? null;

function programNotFound(programId: string): AppError {
  return new AppError(HttpStatus.NOT_FOUND, 'PROGRAM_NOT_FOUND', { detail: `Program ${programId} not found` });
}

@Injectable()
export class AuditQueries {
  constructor(private readonly prisma: PrismaService) {}

  async programExists(programId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM program WHERE external_id = ${programId}) AS exists
    `;
    return rows[0]?.exists ?? false;
  }

  async breaks(filter: BreakFilter, limit: number, cursor: string | undefined): Promise<Page<BreakView>> {
    const after = decodeCursor(cursor, TIME_AND_UUID);
    const rows = await this.prisma.$queryRaw<BreakRow[]>`
      SELECT b.id, coalesce(p.external_id, b.program_external_id) AS program_id, b.reservation_id, r.invoice_id,
             b.reason::text AS reason, b.blocking, b.details - 'essence' AS details, b.message_id, b.opened_at,
             b.resolved_at, b.resolution_message_id
      FROM program_break b
      LEFT JOIN program p ON p.id = b.program_id
      LEFT JOIN reservation r ON r.id = b.reservation_id
      WHERE (${filter.programId ?? null}::text IS NULL
             OR p.external_id = ${filter.programId ?? null} OR b.program_external_id = ${filter.programId ?? null})
        AND (${filter.open ?? null}::boolean IS NULL OR (b.resolved_at IS NULL) = ${filter.open ?? null}::boolean)
        AND (${filter.reason ?? null}::text IS NULL OR b.reason::text = ${filter.reason ?? null})
        AND (${after?.[0] ?? null}::timestamptz IS NULL
             OR (b.opened_at, b.id) < (${after?.[0] ?? null}::timestamptz, ${after?.[1] ?? null}::uuid))
      ORDER BY b.opened_at DESC, b.id DESC
      LIMIT ${limit + 1}
    `;
    return toPage(
      rows,
      limit,
      (row) => [row.opened_at.toISOString(), row.id],
      (row) => ({
        id: row.id,
        programId: row.program_id,
        reservationId: row.reservation_id,
        invoiceId: row.invoice_id,
        reason: row.reason,
        blocking: row.blocking,
        details: row.details,
        messageId: row.message_id,
        openedAt: row.opened_at.toISOString(),
        resolvedAt: iso(row.resolved_at),
        resolutionMessageId: row.resolution_message_id,
      }),
    );
  }

  async ledger(programId: string, limit: number, cursor: string | undefined): Promise<Page<LedgerView>> {
    const program = await this.prisma.$queryRaw<{ id: string; currency: string }[]>`
      SELECT id, currency FROM program WHERE external_id = ${programId}
    `;
    if (!program[0]) throw programNotFound(programId);
    const { id, currency } = program[0];
    const after = decodeCursor(cursor, [CURSOR_PART.integer]);
    const rows = await this.prisma.$queryRaw<LedgerRow[]>`
      SELECT id, type::text AS type, credit_limit_delta, external_utilized_delta, reserved_delta, credit_limit_after,
             external_utilized_after, reserved_after, reservation_id, release_id, message_id, created_at
      FROM capacity_ledger
      WHERE program_id = ${id}::uuid AND (${after?.[0] ?? null}::bigint IS NULL OR id < ${after?.[0] ?? null}::bigint)
      ORDER BY id DESC
      LIMIT ${limit + 1}
    `;
    const amount = (value: LedgerRow['reserved_delta']) => formatCapacity(toDecimal(value));
    return toPage(
      rows,
      limit,
      (row) => [row.id.toString()],
      (row) => ({
        id: row.id.toString(),
        type: row.type,
        delta: {
          creditLimit: amount(row.credit_limit_delta),
          externalUtilized: amount(row.external_utilized_delta),
          reserved: amount(row.reserved_delta),
        },
        after: {
          creditLimit: amount(row.credit_limit_after),
          externalUtilized: amount(row.external_utilized_after),
          reserved: amount(row.reserved_after),
        },
        currency,
        reservationId: row.reservation_id,
        releaseId: row.release_id,
        messageId: row.message_id,
        createdAt: row.created_at.toISOString(),
      }),
    );
  }

  async inbox(filter: InboxFilter, limit: number, cursor: string | undefined): Promise<Page<InboxView>> {
    const after = decodeCursor(cursor, TIME_AND_TEXT);
    const rows = await this.prisma.$queryRaw<InboxRow[]>`
      SELECT message_id, type::text AS type, outcome::text AS outcome, reason, program_external_id, batch_id, version,
             as_of, kafka_timestamp, topic, partition, "offset", processed_at
      FROM processed_message
      WHERE (${filter.programId ?? null}::text IS NULL OR program_external_id = ${filter.programId ?? null})
        AND (${filter.messageId ?? null}::text IS NULL OR message_id = ${filter.messageId ?? null})
        AND (${filter.outcome ?? null}::text IS NULL OR outcome::text = ${filter.outcome ?? null})
        AND (${filter.type ?? null}::text IS NULL OR type::text = ${filter.type ?? null})
        AND (${after?.[0] ?? null}::timestamptz IS NULL
             OR (processed_at, message_id) < (${after?.[0] ?? null}::timestamptz, ${after?.[1] ?? null}::text))
      ORDER BY processed_at DESC, message_id DESC
      LIMIT ${limit + 1}
    `;
    return toPage(
      rows,
      limit,
      (row) => [row.processed_at.toISOString(), row.message_id],
      (row) => ({
        messageId: row.message_id,
        type: row.type,
        outcome: row.outcome,
        reason: row.reason,
        programId: row.program_external_id,
        batchId: row.batch_id,
        version: row.version?.toString() ?? null,
        asOf: row.as_of.toISOString(),
        kafkaTimestamp: row.kafka_timestamp.toISOString(),
        coordinates: { topic: row.topic, partition: row.partition, offset: row.offset.toString() },
        processedAt: row.processed_at.toISOString(),
      }),
    );
  }

  async parked(filter: ParkedFilter, limit: number, cursor: string | undefined): Promise<Page<ParkedView>> {
    const after = decodeCursor(cursor, TIME_AND_TEXT);
    const rows = await this.prisma.$queryRaw<ParkedRow[]>`
      SELECT message_id, type::text AS type, program_external_id, reservation_id, awaiting_kind::text AS awaiting_kind,
             awaiting_ref, envelope, topic, partition, "offset", parked_at, resolved_at
      FROM parked_message
      WHERE (${filter.programId ?? null}::text IS NULL OR program_external_id = ${filter.programId ?? null})
        AND (${filter.unresolved ?? null}::boolean IS NULL OR (resolved_at IS NULL) = ${filter.unresolved ?? null}::boolean)
        AND (${after?.[0] ?? null}::timestamptz IS NULL
             OR (parked_at, message_id) < (${after?.[0] ?? null}::timestamptz, ${after?.[1] ?? null}::text))
      ORDER BY parked_at DESC, message_id DESC
      LIMIT ${limit + 1}
    `;
    return toPage(
      rows,
      limit,
      (row) => [row.parked_at.toISOString(), row.message_id],
      (row) => ({
        messageId: row.message_id,
        type: row.type,
        programId: row.program_external_id,
        reservationId: row.reservation_id,
        awaiting: { kind: row.awaiting_kind, ref: row.awaiting_ref },
        envelope: row.envelope,
        coordinates: { topic: row.topic, partition: row.partition, offset: row.offset.toString() },
        parkedAt: row.parked_at.toISOString(),
        resolvedAt: iso(row.resolved_at),
      }),
    );
  }

  async fundings(reservationId: string, limit: number, cursor: string | undefined): Promise<Page<FundingView>> {
    const exists = isUUID(reservationId)
      ? await this.prisma.$queryRaw<{ exists: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM reservation WHERE id = ${reservationId}::uuid) AS exists
        `
      : [];
    if (!exists[0]?.exists) {
      throw new AppError(HttpStatus.NOT_FOUND, 'RESERVATION_NOT_FOUND', { detail: `Reservation ${reservationId} not found` });
    }
    const after = decodeCursor(cursor, TIME_AND_UUID);
    const rows = await this.prisma.$queryRaw<FundingRow[]>`
      SELECT id, funding_ref, funded_at, message_id, returned_at, return_message_id, created_at
      FROM reservation_funding
      WHERE reservation_id = ${reservationId}::uuid
        AND (${after?.[0] ?? null}::timestamptz IS NULL
             OR (created_at, id) < (${after?.[0] ?? null}::timestamptz, ${after?.[1] ?? null}::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `;
    return toPage(
      rows,
      limit,
      (row) => [row.created_at.toISOString(), row.id],
      (row) => ({
        fundingRef: row.funding_ref,
        fundedAt: row.funded_at.toISOString(),
        messageId: row.message_id,
        returnedAt: iso(row.returned_at),
        returnMessageId: row.return_message_id,
      }),
    );
  }

  async outbox(filter: OutboxFilter, limit: number, cursor: string | undefined): Promise<Page<OutboxView>> {
    const after = decodeCursor(cursor, [CURSOR_PART.integer]);
    const rows = await this.prisma.$queryRaw<OutboxRow[]>`
      SELECT id, event_id::text AS event_id, type::text AS type, partition_key, payload, created_at, published_at
      FROM outbox_event
      WHERE (${filter.unpublished ?? null}::boolean IS NULL OR (published_at IS NULL) = ${filter.unpublished ?? null}::boolean)
        AND (${filter.programId ?? null}::text IS NULL OR partition_key = ${filter.programId ?? null})
        AND (${filter.type ?? null}::text IS NULL OR type::text = ${filter.type ?? null})
        AND (${after?.[0] ?? null}::bigint IS NULL OR id < ${after?.[0] ?? null}::bigint)
      ORDER BY id DESC
      LIMIT ${limit + 1}
    `;
    return toPage(
      rows,
      limit,
      (row) => [row.id.toString()],
      (row) => ({
        eventId: row.event_id,
        type: row.type,
        partitionKey: row.partition_key,
        payload: row.payload,
        createdAt: row.created_at.toISOString(),
        publishedAt: iso(row.published_at),
      }),
    );
  }

  async declines(filter: DeclineFilter, limit: number, cursor: string | undefined): Promise<Page<DeclineJournalView>> {
    const after = decodeCursor(cursor, TIME_AND_UUID);
    const rows = await this.prisma.$queryRaw<DeclineJournalRow[]>`
      SELECT d.id, p.external_id AS program_id, d.invoice_id, d.requested_amount, d.requested_currency, d.code,
             d.details, d.created_by, d.correlation_id, d.created_at
      FROM reservation_decline d
      JOIN program p ON p.id = d.program_id
      WHERE (${filter.programId ?? null}::text IS NULL OR p.external_id = ${filter.programId ?? null})
        AND (${filter.code ?? null}::text IS NULL OR d.code = ${filter.code ?? null})
        AND (${filter.from ?? null}::timestamptz IS NULL OR d.created_at >= ${filter.from ?? null}::timestamptz)
        AND (${filter.to ?? null}::timestamptz IS NULL OR d.created_at < ${filter.to ?? null}::timestamptz)
        AND (${after?.[0] ?? null}::timestamptz IS NULL
             OR (d.created_at, d.id) < (${after?.[0] ?? null}::timestamptz, ${after?.[1] ?? null}::uuid))
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT ${limit + 1}
    `;
    return toPage(
      rows,
      limit,
      (row) => [row.created_at.toISOString(), row.id],
      (row) => ({
        id: row.id,
        programId: row.program_id,
        invoiceId: row.invoice_id,
        requested: {
          amount: formatAmount(toDecimal(row.requested_amount), minorUnits(row.requested_currency)),
          currency: row.requested_currency,
        },
        code: row.code,
        details: row.details,
        createdBy: row.created_by,
        correlationId: row.correlation_id,
        createdAt: row.created_at.toISOString(),
      }),
    );
  }
}
