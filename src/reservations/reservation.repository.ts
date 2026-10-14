import { Injectable } from '@nestjs/common';
import type { Decimal } from 'decimal.js';
import type { Numeric } from '../shared/db/db.types.js';
import { toDecimal as dec } from '../shared/db/numeric.js';
import type { Tx } from '../shared/db/prisma.service.js';
import type { ProgramStatus } from '../shared/domain/program.types.js';
import type { CapacityBalances } from '../shared/money/capacity.types.js';
import type { FxQuote, ProgramState } from './domain/assess.types.js';
import type { Decline, ExistingReservation, NewReservation, StoredResponse } from './reservation.types.js';

@Injectable()
export class ReservationRepository {
  async lockIdempotencyKey(tx: Tx, clientId: string, key: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`idempotency:${clientId}:${key}`}, 0))`;
  }

  async findStoredResponse(
    tx: Tx,
    clientId: string,
    key: string,
  ): Promise<StoredResponse | undefined> {
    const rows = await tx.$queryRaw<
      { request_hash: string; response_status: number; response_body: unknown }[]
    >`
      SELECT request_hash, response_status, response_body
      FROM idempotency_record
      WHERE client_id = ${clientId} AND key = ${key}
    `;
    const row = rows[0];
    return row && {
      requestHash: row.request_hash,
      status: row.response_status,
      body: row.response_body,
    };
  }

  async storeResponse(
    tx: Tx,
    clientId: string,
    key: string,
    response: StoredResponse,
    expiresAt: Date,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO idempotency_record (client_id, key, request_hash, response_status, response_body, expires_at)
      VALUES (${clientId}, ${key}, ${response.requestHash}, ${response.status}, ${JSON.stringify(response.body)}::jsonb, ${expiresAt})
    `;
  }

  async lockProgram(tx: Tx, externalId: string): Promise<ProgramState | undefined> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        external_id: string;
        client_ref: string;
        currency: string;
        credit_limit: Numeric;
        external_utilized: Numeric;
        reserved: Numeric;
        status: ProgramStatus;
        open_blocking_breaks: number;
      }[]
    >`
      SELECT id, external_id, client_ref, currency, credit_limit, external_utilized,
             reserved, status::text AS status, open_blocking_breaks
      FROM program
      WHERE external_id = ${externalId}
      FOR UPDATE
    `;
    const row = rows[0];
    return row && {
      id: row.id,
      externalId: row.external_id,
      clientRef: row.client_ref,
      currency: row.currency,
      creditLimit: dec(row.credit_limit),
      externalUtilized: dec(row.external_utilized),
      reserved: dec(row.reserved),
      status: row.status,
      openBlockingBreaks: row.open_blocking_breaks,
    };
  }

  async findByInvoice(
    tx: Tx,
    invoiceId: string,
  ): Promise<ExistingReservation | undefined> {
    const rows = await tx.$queryRaw<
      { id: string; status: string; program_id: string; invoice_id: string }[]
    >`
      SELECT r.id, r.status::text AS status, p.external_id AS program_id, r.invoice_id
      FROM reservation r
      JOIN program p ON p.id = r.program_id
      WHERE r.invoice_id = ${invoiceId}
    `;
    const row = rows[0];
    return row && {
      id: row.id,
      status: row.status,
      programId: row.program_id,
      invoiceId: row.invoice_id,
    };
  }

  async currentValuationRate(
    tx: Tx,
    from: string,
    to: string,
  ): Promise<FxQuote | undefined> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        external_id: string;
        status: 'ACTIVE' | 'SUSPENDED';
        rate: Numeric | null;
        effective_as_of: Date;
      }[]
    >`
      SELECT id, external_id, status::text AS status, rate,
             least(as_of, kafka_timestamp) AS effective_as_of
      FROM fx_rate
      WHERE from_currency = ${from} AND to_currency = ${to} AND rate_type = 'VALUATION'
      ORDER BY version DESC
      LIMIT 1
    `;
    const row = rows[0];
    return row && {
      id: row.id,
      rateId: row.external_id,
      status: row.status,
      rate: row.rate === null ? undefined : dec(row.rate),
      effectiveAsOf: row.effective_as_of,
    };
  }

  async savepoint(tx: Tx): Promise<void> {
    await tx.$executeRaw`SAVEPOINT reserve`;
  }

  async rollbackToSavepoint(tx: Tx): Promise<void> {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT reserve`;
  }

  async releaseSavepoint(tx: Tx): Promise<void> {
    await tx.$executeRaw`RELEASE SAVEPOINT reserve`;
  }

  async insertReservation(
    tx: Tx,
    reservation: NewReservation,
  ): Promise<{ id: string; createdAt: Date } | undefined> {
    const rows = await tx.$queryRaw<{ id: string; created_at: Date }[]>`
      INSERT INTO reservation (
        program_id, invoice_id, original_amount, original_currency, fx_rate_id,
        amount, due_date, created_by, correlation_id, updated_at
      ) VALUES (
        ${reservation.programId}::uuid, ${reservation.invoiceId},
        ${reservation.originalAmount.toString()}::numeric, ${reservation.originalCurrency},
        ${reservation.fxRateId}::uuid, ${reservation.amount.toString()}::numeric,
        ${reservation.dueDate}::date, ${reservation.createdBy}, ${reservation.correlationId}, now()
      )
      ON CONFLICT (invoice_id) DO NOTHING
      RETURNING id, created_at
    `;
    const row = rows[0];
    return row && { id: row.id, createdAt: row.created_at };
  }

  async consumeCapacity(
    tx: Tx,
    programId: string,
    amount: Decimal,
  ): Promise<CapacityBalances | undefined> {
    const rows = await tx.$queryRaw<
      { credit_limit: Numeric; external_utilized: Numeric; reserved: Numeric }[]
    >`
      UPDATE program
      SET reserved = reserved + ${amount.toString()}::numeric, updated_at = now()
      WHERE id = ${programId}::uuid
        AND status = 'ACTIVE'
        AND open_blocking_breaks = 0
        AND reserved + external_utilized + ${amount.toString()}::numeric <= credit_limit
      RETURNING credit_limit, external_utilized, reserved
    `;
    const row = rows[0];
    return row && {
      creditLimit: dec(row.credit_limit),
      externalUtilized: dec(row.external_utilized),
      reserved: dec(row.reserved),
    };
  }

  async insertReserveLedger(
    tx: Tx,
    programId: string,
    reservationId: string,
    amount: Decimal,
    after: CapacityBalances,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO capacity_ledger (
        program_id, type, reserved_delta, credit_limit_after, external_utilized_after,
        reserved_after, reservation_id
      ) VALUES (
        ${programId}::uuid, 'RESERVE', ${amount.toString()}::numeric,
        ${after.creditLimit.toString()}::numeric, ${after.externalUtilized.toString()}::numeric,
        ${after.reserved.toString()}::numeric, ${reservationId}::uuid
      )
    `;
  }

  async insertDecline(tx: Tx, decline: Decline): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO reservation_decline (
        program_id, invoice_id, requested_amount, requested_currency, code, details,
        created_by, correlation_id
      ) VALUES (
        ${decline.programId}::uuid, ${decline.invoiceId}, ${decline.requestedAmount.toString()}::numeric,
        ${decline.requestedCurrency}, ${decline.code}, ${JSON.stringify(decline.details)}::jsonb,
        ${decline.createdBy}, ${decline.correlationId}
      )
    `;
  }
}