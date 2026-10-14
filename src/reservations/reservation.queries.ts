import { HttpStatus, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Decimal } from 'decimal.js';
import { RateQueries } from '../rates/rates.queries.js';
import type { Principal } from '../shared/auth/principal.types.js';
import { Scope } from '../shared/auth/scopes.js';
import { clientRefFilter, programScope } from '../shared/auth/visibility.js';
import type { ProgramScope } from '../shared/auth/visibility.types.js';
import { toDecimal as dec } from '../shared/db/numeric.js';
import { PrismaService } from '../shared/db/prisma.service.js';
import { AppError } from '../shared/errors/app-error.js';
import { CURSOR_PART, decodeCursor, toPage } from '../shared/http/pagination.js';
import type { Page } from '../shared/http/pagination.types.js';
import { minorUnits } from '../shared/money/currency.js';
import { ceilTo, formatAmount, formatCapacity } from '../shared/money/money.js';
import { Clock } from '../shared/time/clock.js';
import type {
  Amount,
  BreakRow,
  DeclineRow,
  DeclineView,
  MovementRow,
  MovementView,
  PayoffQuote,
  PendingRow,
  PendingView,
  ReservationCard,
  ReservationFilter,
  ReservationRow,
  ReservationView,
  Viewer,
} from './reservation-views.types.js';

const RESERVATIONS = `
  SELECT r.id, p.external_id AS program_id, p.client_ref, r.invoice_id, r.status::text AS status, r.original_amount,
         r.original_currency, r.amount, p.currency, f.external_id AS fx_rate_id, r.due_date::text AS due_date,
         r.released_original_amount, r.released_amount, r.funded_at, r.funding_ref, r.created_at
  FROM reservation r
  JOIN program p ON p.id = r.program_id
  LEFT JOIN fx_rate f ON f.id = r.fx_rate_id`;

const inCurrency = (value: Decimal, currency: string): Amount => ({
  amount: formatAmount(value, minorUnits(currency)),
  currency,
});

const inCapacity = (value: Decimal, currency: string): Amount => ({
  amount: formatCapacity(value),
  currency,
});

function notFound(id: string): AppError {
  return new AppError(HttpStatus.NOT_FOUND, 'RESERVATION_NOT_FOUND', { detail: `Reservation ${id} not found` });
}

function textField(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  return typeof value === 'string' ? value : null;
}

function amountField(payload: Record<string, unknown>, field: string): Amount | null {
  const value = payload[field];
  if (typeof value !== 'object' || value === null) return null;
  const { amount, currency } = value as Record<string, unknown>;
  return typeof amount === 'string' && typeof currency === 'string' ? { amount, currency } : null;
}

const EXTERNAL_REF_FIELDS = ['allocationId', 'writeOffId', 'cancellationId', 'reversalId', 'fundingRef'];

function pendingView(row: PendingRow): PendingView {
  return {
    messageId: row.message_id,
    type: row.type,
    externalRef: EXTERNAL_REF_FIELDS.map((field) => textField(row.payload, field)).find((ref) => ref !== null) ?? null,
    amount: amountField(row.payload, 'settledAmount') ?? amountField(row.payload, 'amount'),
    payment: amountField(row.payload, 'payment'),
    awaiting: { kind: row.awaiting_kind, ref: row.awaiting_ref },
    since: row.parked_at.toISOString(),
  };
}

export function viewerOf(principal: Principal): Viewer {
  return {
    scope: programScope(principal),
    seesBreaks: principal.scopes.has(Scope.BreaksRead),
    seesFundingRef: principal.scopes.has(Scope.ProgramsReadAll),
  };
}

@Injectable()
export class ReservationQueries {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rates: RateQueries,
    private readonly clock: Clock,
  ) {}

  async list(
    viewer: Viewer,
    filter: ReservationFilter,
    limit: number,
    cursor: string | undefined,
  ): Promise<Page<ReservationView>> {
    if (viewer.scope.kind === 'none') return { items: [], nextCursor: null };
    if (filter.programId !== undefined && !(await this.programVisible(viewer.scope, filter.programId))) {
      throw new AppError(HttpStatus.NOT_FOUND, 'PROGRAM_NOT_FOUND', { detail: `Program ${filter.programId} not found` });
    }
    const after = decodeCursor(cursor, [CURSOR_PART.instant, CURSOR_PART.uuid]);
    const rows = await this.prisma.$queryRawUnsafe<ReservationRow[]>(
      `${RESERVATIONS}
       WHERE ($1::text IS NULL OR p.client_ref = $1)
         AND ($2::text IS NULL OR p.external_id = $2)
         AND ($3::text IS NULL OR r.invoice_id = $3)
         AND ($4::text IS NULL OR r.status::text = $4)
         AND ($5::timestamptz IS NULL OR (r.created_at, r.id) < ($5::timestamptz, $6::uuid))
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT $7`,
      clientRefFilter(viewer.scope),
      filter.programId ?? null,
      filter.invoiceId ?? null,
      filter.status ?? null,
      after?.[0] ?? null,
      after?.[1] ?? null,
      limit + 1,
    );
    return toPage(rows, limit, (row) => [row.created_at.toISOString(), row.id], (row) => this.view(row, viewer));
  }

  async card(viewer: Viewer, id: string): Promise<ReservationCard> {
    const row = await this.find(viewer.scope, id);
    const [movements, pending, breaks] = await Promise.all([
      this.movements(row),
      this.pending(row.id),
      viewer.seesBreaks ? this.breaks(row.id) : Promise.resolve(undefined),
    ]);
    return { ...this.view(row, viewer), movements, pending, ...(breaks ? { breaks } : {}) };
  }

  async payoff(viewer: Viewer, id: string, currency: string | undefined): Promise<PayoffQuote> {
    const row = await this.find(viewer.scope, id);
    const owed = dec(row.original_amount).minus(dec(row.released_original_amount));
    const target = currency ?? row.original_currency;
    const base = {
      reservationId: row.id,
      invoiceId: row.invoice_id,
      outstanding: inCurrency(owed, row.original_currency),
      quotedAt: this.clock.now().toISOString(),
    };
    if (target === row.original_currency) return { ...base, payoff: inCurrency(owed, target), fx: null };

    const quote = await this.rates.current(target, row.original_currency, 'CONVERSION');
    if (!quote) {
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'FX_RATE_UNAVAILABLE', {
        detail: `No CONVERSION quote ${target}/${row.original_currency}`,
      });
    }
    if (quote.status === 'SUSPENDED' || !quote.rate) {
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'FX_RATE_SUSPENDED', {
        detail: `CONVERSION quote ${target}/${row.original_currency} is suspended`,
        extensions: { fxRateId: quote.rateId },
      });
    }
    return {
      ...base,
      payoff: inCurrency(ceilTo(owed.div(quote.rate), minorUnits(target)), target),
      fx: { rateId: quote.rateId, rate: quote.rate.toFixed(), asOf: quote.asOf.toISOString() },
    };
  }

  async declines(createdBy: string, invoiceId: string, limit: number, cursor: string | undefined): Promise<Page<DeclineView>> {
    const after = decodeCursor(cursor, [CURSOR_PART.instant, CURSOR_PART.uuid]);
    const rows = await this.prisma.$queryRaw<DeclineRow[]>`
      SELECT d.id, p.external_id AS program_id, d.invoice_id, d.requested_amount, d.requested_currency, d.code, d.details,
             d.correlation_id, d.created_at
      FROM reservation_decline d
      JOIN program p ON p.id = d.program_id
      WHERE d.invoice_id = ${invoiceId} AND d.created_by = ${createdBy}
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
        requested: inCurrency(dec(row.requested_amount), row.requested_currency),
        code: row.code,
        details: row.details,
        correlationId: row.correlation_id,
        createdAt: row.created_at.toISOString(),
      }),
    );
  }

  private async programVisible(scope: ProgramScope, programId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM program WHERE external_id = ${programId}
          AND (${clientRefFilter(scope)}::text IS NULL OR client_ref = ${clientRefFilter(scope)})
      ) AS exists
    `;
    return rows[0]?.exists ?? false;
  }

  private async find(scope: ProgramScope, id: string): Promise<ReservationRow> {
    if (scope.kind === 'none' || !isUUID(id)) throw notFound(id);
    const rows = await this.prisma.$queryRawUnsafe<ReservationRow[]>(
      `${RESERVATIONS}
       WHERE r.id = $1::uuid AND ($2::text IS NULL OR p.client_ref = $2)`,
      id,
      clientRefFilter(scope),
    );
    if (!rows[0]) throw notFound(id);
    return rows[0];
  }

  private view(row: ReservationRow, viewer: Viewer): ReservationView {
    const owed = dec(row.original_amount).minus(dec(row.released_original_amount));
    return {
      id: row.id,
      programId: row.program_id,
      invoiceId: row.invoice_id,
      status: row.status,
      original: inCurrency(dec(row.original_amount), row.original_currency),
      capacity: inCapacity(dec(row.amount), row.currency),
      fxRateId: row.fx_rate_id,
      dueDate: row.due_date,
      outstanding: inCurrency(owed, row.original_currency),
      capacityOutstanding: inCapacity(dec(row.amount).minus(dec(row.released_amount)), row.currency),
      funding: row.funded_at
        ? {
            fundedAt: row.funded_at.toISOString(),
            ...(viewer.seesFundingRef && row.funding_ref ? { fundingRef: row.funding_ref } : {}),
          }
        : null,
      createdAt: row.created_at.toISOString(),
    };
  }

  private async movements(reservation: ReservationRow): Promise<MovementView[]> {
    const rows = await this.prisma.$queryRaw<MovementRow[]>`
      SELECT rr.id, rr.reason::text AS reason, rr.external_ref, rr.original_amount, rr.amount, rr.payment_id,
             rr.payment_amount, rr.payment_currency, q.external_id AS payment_rate_id, q.rate AS payment_rate,
             rr.cancellation_reason, rr.write_off_reason, t.external_ref AS reverses_external_ref,
             least(m.as_of, m.kafka_timestamp) AS as_of, rr.created_at
      FROM reservation_release rr
      JOIN capacity_ledger l ON l.release_id = rr.id
      JOIN processed_message m ON m.message_id = rr.message_id
      LEFT JOIN fx_rate q ON q.id = rr.payment_fx_rate_id
      LEFT JOIN reservation_release t ON t.id = rr.reverses_release_id
      WHERE rr.reservation_id = ${reservation.id}::uuid
      ORDER BY l.id
    `;
    const invoiceCurrency = reservation.original_currency;
    let owed = dec(reservation.original_amount);
    return rows.map((row) => {
      const amount = dec(row.original_amount);
      owed = row.reason === 'REVERSAL' ? owed.plus(amount) : owed.minus(amount);
      const payment =
        row.reason === 'REPAYMENT' && row.payment_id && row.payment_amount !== null && row.payment_currency
          ? {
              id: row.payment_id,
              amount: inCurrency(dec(row.payment_amount), row.payment_currency),
              fx:
                row.payment_rate_id && row.payment_rate !== null
                  ? { rateId: row.payment_rate_id, rate: dec(row.payment_rate).toFixed() }
                  : null,
            }
          : undefined;
      const reason = row.cancellation_reason ?? row.write_off_reason ?? undefined;
      return {
        id: row.id,
        kind: row.reason,
        externalRef: row.external_ref,
        amount: inCurrency(amount, invoiceCurrency),
        capacity: inCapacity(dec(row.amount), reservation.currency),
        ...(payment ? { payment } : {}),
        ...(reason ? { reason } : {}),
        ...(row.reverses_external_ref ? { reverses: row.reverses_external_ref } : {}),
        outstandingAfter: inCurrency(owed, invoiceCurrency),
        asOf: row.as_of.toISOString(),
        recordedAt: row.created_at.toISOString(),
      };
    });
  }

  private async pending(reservationId: string): Promise<PendingView[]> {
    const rows = await this.prisma.$queryRaw<PendingRow[]>`
      SELECT message_id, type::text AS type, awaiting_kind::text AS awaiting_kind, awaiting_ref,
             coalesce(envelope -> 'payload', '{}'::jsonb) AS payload, parked_at
      FROM parked_message
      WHERE reservation_id = ${reservationId}::uuid AND resolved_at IS NULL
      ORDER BY partition, "offset"
    `;
    return rows.map(pendingView);
  }

  private async breaks(reservationId: string) {
    const rows = await this.prisma.$queryRaw<BreakRow[]>`
      SELECT id, reason::text AS reason, blocking, opened_at, resolved_at, details - 'essence' AS details
      FROM program_break
      WHERE reservation_id = ${reservationId}::uuid
      ORDER BY opened_at, id
    `;
    return rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      blocking: row.blocking,
      openedAt: row.opened_at.toISOString(),
      resolvedAt: row.resolved_at?.toISOString() ?? null,
      details: row.details,
    }));
  }
}
