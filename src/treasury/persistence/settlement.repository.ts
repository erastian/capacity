import { Injectable } from '@nestjs/common';
import type { Decimal } from 'decimal.js';
import { toDecimal as dec } from '../../shared/db/numeric.js';
import type { Tx } from '../../shared/db/prisma.service.js';
import type { NewRelease, ReservationBalances, ReservationView, StoredFunding, StoredRelease } from '../domain/invoice-decision.types.js';
import type { ProgramView } from '../domain/program-decision.types.js';
import type { FundingRow, ReleaseRow, ReservationRow } from '../inbound.types.js';

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

@Injectable()
export class SettlementRepository {
  async findReservation(tx: Tx, invoiceId: string): Promise<ReservationView | undefined> {
    const rows = await tx.$queryRawUnsafe<ReservationRow[]>(`SELECT ${RESERVATION_COLUMNS} ${RESERVATION_FROM} WHERE r.invoice_id = $1`, invoiceId);
    return rows[0] && toReservation(rows[0]);
  }

  async lockReservation(tx: Tx, id: string): Promise<ReservationView> {
    const rows = await tx.$queryRawUnsafe<ReservationRow[]>(`SELECT ${RESERVATION_COLUMNS} ${RESERVATION_FROM} WHERE r.id = $1::uuid FOR UPDATE OF r`, id);
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
}
