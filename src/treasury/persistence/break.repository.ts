import { Injectable } from '@nestjs/common';
import type { Tx } from '../../shared/db/prisma.service.js';
import type { BreakView } from '../domain/break-closure.types.js';
import type { InvoiceBreak } from '../domain/invoice-decision.types.js';
import type { BreakSpec, ProgramView } from '../domain/program-decision.types.js';
import type { BreakRow } from '../inbound.types.js';

@Injectable()
export class BreakRepository {
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
