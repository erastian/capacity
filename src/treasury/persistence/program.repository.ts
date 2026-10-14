import { Injectable } from '@nestjs/common';
import type { Decimal } from 'decimal.js';
import type { Numeric } from '../../shared/db/db.types.js';
import { toDecimal as dec } from '../../shared/db/numeric.js';
import type { Tx } from '../../shared/db/prisma.service.js';
import type { CapacityBalances } from '../../shared/money/capacity.types.js';
import type { LedgerKind, NewProgram, ProgramChanges, ProgramView } from '../domain/program-decision.types.js';
import type { ProgramRow } from '../inbound.types.js';

const PROGRAM_COLUMNS = `id, external_id, client_ref, currency, credit_limit, credit_limit_version,
  external_utilized, external_utilized_version, reserved, status::text AS status, status_reason, status_version`;

const big = (value: Numeric | null) => (value === null ? null : BigInt(value.toString()));

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

@Injectable()
export class ProgramStateRepository {
  async lockProgram(tx: Tx, externalId: string): Promise<ProgramView | undefined> {
    const rows = await tx.$queryRawUnsafe<ProgramRow[]>(
      `SELECT ${PROGRAM_COLUMNS} FROM program WHERE external_id = $1 FOR UPDATE`,
      externalId,
    );
    return rows[0] && toProgram(rows[0]);
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
}