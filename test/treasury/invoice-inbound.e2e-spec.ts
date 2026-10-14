import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { EventPublisher } from '../../src/outbox/event-publisher.js';
import type { RawMessage } from '../../src/treasury/adapter/envelope.types.js';
import { InboundProcessor } from '../../src/treasury/inbound.processor.js';
import { startApp } from '../support/app.js';
import { CapturingPublisher } from '../support/capturing-publisher.js';
import { closeDb, db, seedProgram, seedRate, unique } from '../support/db.js';
import { token } from '../support/issuer.js';

const ORIGINATION = { sub: 'svc-origination', azp: 'origination', scope: 'reservations:write programs:read:all' };

let offset = 0n;
let quoteVersion = BigInt(Date.now()) * 1000n;

function message(type: string, programId: string, payload: Record<string, unknown>, messageId = unique('m')): RawMessage & { messageId: string } {
  return {
    messageId,
    topic: 'treasury.program-capacity',
    partition: 0,
    offset: offset++,
    key: programId,
    value: JSON.stringify({
      messageId,
      type,
      schemaVersion: 1,
      programId,
      asOf: new Date(Date.now() - 1000).toISOString(),
      payload,
    }),
    timestamp: new Date(),
  };
}

function conversionQuote(rateId: string, rate = '4.6512'): RawMessage {
  const messageId = unique('m');
  return {
    topic: 'treasury.fx-rates',
    partition: 0,
    offset: offset++,
    key: 'RON:CZK:CONVERSION',
    value: JSON.stringify({
      messageId,
      type: 'FX_RATE_PUBLISHED',
      schemaVersion: 1,
      version: (++quoteVersion).toString(),
      asOf: new Date(Date.now() - 1000).toISOString(),
      payload: { rateId, from: 'RON', to: 'CZK', rateType: 'CONVERSION', status: 'ACTIVE', rate },
    }),
    timestamp: new Date(),
  };
}

const czk = (amount: string) => ({ amount, currency: 'CZK' });

describe('treasury invoice messages', () => {
  let app: NestFastifyApplication;
  let processor: InboundProcessor;
  let bearer: string;

  beforeAll(async () => {
    app = await startApp(undefined, (builder) =>
      builder.overrideProvider(EventPublisher).useValue(new CapturingPublisher()),
    );
    processor = app.get(InboundProcessor);
    bearer = await token({ claims: ORIGINATION });
    await seedRate({ from: 'CZK', to: 'EUR', rate: '0.0397' });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const reserveRaw = (programId: string, amount = '10000.00') =>
    app.inject({
      method: 'POST',
      url: '/v1/reservations',
      headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': unique('key') },
      payload: { programId, invoiceId: unique('INV'), amount, currency: 'CZK', dueDate: '2099-12-31' },
    });

  const reserve = async (programId: string, amount?: string) => {
    const res = await reserveRaw(programId, amount);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    return { id: body.id as string, invoiceId: body.invoiceId as string, programId };
  };

  type Invoice = Awaited<ReturnType<typeof reserve>>;

  const send = async (raw: RawMessage & { messageId?: string }) => {
    await processor.process(raw);
    return raw.messageId!;
  };

  const funded = (invoice: Invoice, fundingRef: string) =>
    send(message('INVOICE_FUNDED', invoice.programId, { invoiceId: invoice.invoiceId, fundingRef }));

  const returned = (invoice: Invoice, fundingRef: string) =>
    send(message('INVOICE_FUNDING_RETURNED', invoice.programId, { invoiceId: invoice.invoiceId, fundingRef }));

  const allocated = (invoice: Invoice, amount: string, allocationId = unique('A'), programId = invoice.programId) =>
    send(
      message('INVOICE_PAYMENT_ALLOCATED', programId, {
        invoiceId: invoice.invoiceId,
        allocationId,
        paymentId: `PAY-${allocationId}`,
        payment: czk(amount),
        settledAmount: czk(amount),
      }),
    );

  const allocatedInRon = (invoice: Invoice, payment: string, settled: string, fxRateId: string) =>
    send(
      message('INVOICE_PAYMENT_ALLOCATED', invoice.programId, {
        invoiceId: invoice.invoiceId,
        allocationId: unique('A'),
        paymentId: unique('PAY'),
        payment: { amount: payment, currency: 'RON' },
        settledAmount: czk(settled),
        fxRateId,
      }),
    );

  const writtenOff = (invoice: Invoice, amount: string) =>
    send(
      message('INVOICE_BALANCE_WRITTEN_OFF', invoice.programId, {
        invoiceId: invoice.invoiceId,
        writeOffId: unique('W'),
        amount: czk(amount),
        writeOffReason: 'ROUNDING_TOLERANCE',
      }),
    );

  const cancelled = (invoice: Invoice, cancellationId = unique('C')) =>
    send(
      message('INVOICE_FUNDING_CANCELLED', invoice.programId, {
        invoiceId: invoice.invoiceId,
        cancellationId,
        cancellationReason: 'SUPPLIER_WITHDREW',
      }),
    );

  const reversed = (invoice: Invoice, externalRef: string) =>
    send(
      message('INVOICE_RELEASE_REVERSED', invoice.programId, {
        invoiceId: invoice.invoiceId,
        reversalId: unique('REV'),
        externalRef,
      }),
    );

  const inbox = async (messageId: string) =>
    (await db().query('SELECT outcome::text AS outcome, reason FROM processed_message WHERE message_id = $1', [messageId]))
      .rows[0];

  const reservation = async (id: string) =>
    (
      await db().query(
        `SELECT status::text AS status, released_original_amount, released_amount, funding_ref, funded_at
         FROM reservation WHERE id = $1`,
        [id],
      )
    ).rows[0];

  const program = async (externalId: string) =>
    (await db().query('SELECT id, reserved, open_blocking_breaks FROM program WHERE external_id = $1', [externalId])).rows[0];

  const parked = async (messageId: string) =>
    (
      await db().query(
        'SELECT awaiting_kind::text AS awaiting_kind, awaiting_ref, resolved_at FROM parked_message WHERE message_id = $1',
        [messageId],
      )
    ).rows[0];

  const events = async (programId: string, type: string) =>
    (
      await db().query(
        `SELECT payload -> 'data' AS data FROM outbox_event WHERE partition_key = $1 AND type = $2::"OutboundEventType" ORDER BY id`,
        [programId, type],
      )
    ).rows.map((row) => row.data);

  const breaks = async (programId: string) =>
    (
      await db().query(
        `SELECT b.reason::text AS reason, b.blocking, b.reservation_id FROM program_break b
         JOIN program p ON p.id = b.program_id WHERE p.external_id = $1 ORDER BY b.opened_at`,
        [programId],
      )
    ).rows;

  async function expectReconciled(programId: string) {
    const { rows } = await db().query(
      `SELECT p.reserved,
              (SELECT coalesce(sum(r.amount - r.released_amount), 0) FROM reservation r WHERE r.program_id = p.id) AS exposure,
              (SELECT l.reserved_after FROM capacity_ledger l WHERE l.program_id = p.id ORDER BY l.id DESC LIMIT 1) AS ledger,
              (SELECT coalesce(sum(CASE WHEN rr.reason = 'REVERSAL' THEN -rr.original_amount ELSE rr.original_amount END), 0)
                 FROM reservation_release rr JOIN reservation r ON r.id = rr.reservation_id WHERE r.program_id = p.id) AS releases,
              (SELECT coalesce(sum(r.released_original_amount), 0) FROM reservation r WHERE r.program_id = p.id) AS released
       FROM program p WHERE p.external_id = $1`,
      [programId],
    );
    const row = rows[0];
    expect(row.exposure).toBe(row.reserved);
    expect(row.ledger).toBe(row.reserved);
    expect(row.releases).toBe(row.released);
  }

  it('pays an invoice off in parts and returns the exact capacity', async () => {
    const programId = await seedProgram({ creditLimit: '10000' });
    const invoice = await reserve(programId);
    expect((await program(programId)).reserved).toBe('397.0000');

    expect(await inbox(await funded(invoice, unique('F')))).toEqual({ outcome: 'APPLIED', reason: null });
    await allocated(invoice, '2500.00');
    expect(await reservation(invoice.id)).toMatchObject({
      status: 'PARTIALLY_RELEASED',
      released_original_amount: '2500.0000',
      released_amount: '99.2500',
    });

    await allocated(invoice, '7499.97');
    await writtenOff(invoice, '0.03');
    expect(await reservation(invoice.id)).toMatchObject({ status: 'RELEASED', released_amount: '397.0000' });
    expect((await program(programId)).reserved).toBe('0.0000');

    const released = await events(programId, 'RESERVATION_RELEASED');
    expect(released).toHaveLength(3);
    expect(released[0]).toMatchObject({
      reservationId: invoice.id,
      reason: 'REPAYMENT',
      originalAmount: '2500.00',
      originalCurrency: 'CZK',
      amount: '99.2500',
      currency: 'EUR',
      status: 'PARTIALLY_RELEASED',
      outstanding: '7500.00',
      capacityOutstanding: '297.7500',
    });
    expect(released[2]).toMatchObject({ reason: 'WRITE_OFF', status: 'RELEASED', outstanding: '0.00', capacityOutstanding: '0.0000' });
    await expectReconciled(programId);
  });

  it('follows funding, its return and a second funding', async () => {
    const programId = await seedProgram({ creditLimit: '10000' });
    const invoice = await reserve(programId);
    const [first, second] = [unique('F'), unique('F')];

    await funded(invoice, first);
    expect(await reservation(invoice.id)).toMatchObject({ funding_ref: first });
    expect(await inbox(await funded(invoice, first))).toEqual({ outcome: 'STALE', reason: null });

    await returned(invoice, first);
    expect(await reservation(invoice.id)).toMatchObject({ funding_ref: null, funded_at: null });
    expect(await inbox(await funded(invoice, first))).toMatchObject({ outcome: 'REJECTED', reason: 'FUNDING_CONFLICT' });

    await funded(invoice, second);
    expect(await reservation(invoice.id)).toMatchObject({ funding_ref: second });
    expect((await program(programId)).reserved).toBe('397.0000');
  });

  it('cancels an invoice and restores it with a reversal of the cancellation', async () => {
    const programId = await seedProgram({ creditLimit: '10000' });
    const invoice = await reserve(programId);
    const cancellationId = unique('C');

    await cancelled(invoice, cancellationId);
    expect(await reservation(invoice.id)).toMatchObject({ status: 'CANCELLED', released_amount: '397.0000' });
    expect((await program(programId)).reserved).toBe('0.0000');
    expect(await events(programId, 'RESERVATION_CANCELLED')).toMatchObject([{ reason: 'CANCELLATION', status: 'CANCELLED' }]);
    expect(await inbox(await cancelled(invoice, cancellationId))).toEqual({ outcome: 'STALE', reason: null });

    await reversed(invoice, cancellationId);
    expect(await reservation(invoice.id)).toMatchObject({ status: 'ACTIVE', released_amount: '0.0000' });
    expect((await program(programId)).reserved).toBe('397.0000');
    expect(await events(programId, 'RESERVATION_RELEASE_REVERSED')).toMatchObject([{ status: 'ACTIVE', amount: '397.0000' }]);
    await expectReconciled(programId);
  });

  it('takes capacity back on a reversal even over the limit', async () => {
    const programId = await seedProgram({ creditLimit: '10000' });
    const invoice = await reserve(programId);
    const allocationId = unique('A');
    await allocated(invoice, '10000.00', allocationId);
    await db().query('UPDATE program SET credit_limit = 100 WHERE external_id = $1', [programId]);

    await reversed(invoice, allocationId);
    expect((await program(programId)).reserved).toBe('397.0000');
    expect(await events(programId, 'PROGRAM_LIMIT_EXCESS_STARTED')).toMatchObject([{ overLimit: '297.0000' }]);
    await expectReconciled(programId);
  });

  it('resolves a resent allocation by its allocationId', async () => {
    const programId = await seedProgram({ creditLimit: '10000' });
    const invoice = await reserve(programId);
    const allocationId = unique('A');
    await allocated(invoice, '1000.00', allocationId);

    expect(await inbox(await allocated(invoice, '1000.00', allocationId))).toEqual({ outcome: 'STALE', reason: null });
    expect(await inbox(await allocated(invoice, '999.00', allocationId))).toMatchObject({
      outcome: 'REJECTED',
      reason: 'EXTERNAL_REF_CONFLICT',
    });
    expect(await reservation(invoice.id)).toMatchObject({ released_original_amount: '1000.0000' });
  });

  it('opens breaks against the right programme and reservation', async () => {
    const programId = await seedProgram({ creditLimit: '10000' });
    const otherProgramId = await seedProgram({ creditLimit: '10000' });
    const invoice = await reserve(programId);

    const unknown = await allocated({ ...invoice, invoiceId: unique('INV') }, '1.00');
    expect(await inbox(unknown)).toMatchObject({ outcome: 'REJECTED', reason: 'UNKNOWN_INVOICE' });

    const foreign = await allocated(invoice, '1.00', unique('A'), otherProgramId);
    expect(await inbox(foreign)).toMatchObject({ outcome: 'REJECTED', reason: 'PROGRAM_MISMATCH' });

    expect(await breaks(otherProgramId)).toEqual([]);
    expect(await breaks(programId)).toEqual([
      { reason: 'UNKNOWN_INVOICE', blocking: false, reservation_id: null },
      { reason: 'PROGRAM_MISMATCH', blocking: false, reservation_id: invoice.id },
    ]);
    expect(await reservation(invoice.id)).toMatchObject({ status: 'ACTIVE' });
  });

  it('puts the programme on hold when a cancelled invoice gets funded', async () => {
    const programId = await seedProgram({ creditLimit: '10000' });
    const invoice = await reserve(programId);
    await cancelled(invoice);

    expect(await inbox(await funded(invoice, unique('F')))).toMatchObject({
      outcome: 'REJECTED',
      reason: 'FUNDED_AFTER_CANCELLATION',
    });
    expect((await program(programId)).open_blocking_breaks).toBe(1);
    const declined = await reserveRaw(programId);
    expect(declined.statusCode).toBe(409);
    expect(declined.json().code).toBe('PROGRAM_ON_HOLD');
  });

  it('parks an allocation until its quote arrives and keeps the reservation order', async () => {
    const programId = await seedProgram({ creditLimit: '10000' });
    const invoice = await reserve(programId);
    const neighbour = await reserve(programId, '1000.00');
    const rateId = unique('R');

    const allocation = await allocatedInRon(invoice, '500.00', '2325.60', rateId);
    const cancellation = await cancelled(invoice);
    expect(await parked(allocation)).toMatchObject({ awaiting_kind: 'FX_RATE', awaiting_ref: rateId, resolved_at: null });
    expect(await parked(cancellation)).toMatchObject({ awaiting_kind: 'PRECEDING_MESSAGE', awaiting_ref: allocation });

    const free = await allocated(neighbour, '1000.00');
    expect(await inbox(free)).toEqual({ outcome: 'APPLIED', reason: null });

    await send(conversionQuote(rateId));
    expect(await inbox(allocation)).toEqual({ outcome: 'APPLIED', reason: null });
    expect(await inbox(cancellation)).toMatchObject({ outcome: 'REJECTED', reason: 'CANCELLATION_AFTER_SETTLEMENT' });
    expect(await reservation(invoice.id)).toMatchObject({ status: 'PARTIALLY_RELEASED', released_original_amount: '2325.6000' });
    await expectReconciled(programId);
  });

  it('parks a queued allocation again when it turns out to wait for its own quote', async () => {
    const programId = await seedProgram({ creditLimit: '10000' });
    const invoice = await reserve(programId);
    const [firstRate, secondRate] = [unique('R'), unique('R')];

    const first = await allocatedInRon(invoice, '500.00', '2325.60', firstRate);
    const second = await allocatedInRon(invoice, '100.00', '465.12', secondRate);
    expect(await parked(second)).toMatchObject({ awaiting_kind: 'PRECEDING_MESSAGE', awaiting_ref: first });

    await send(conversionQuote(firstRate));
    expect(await inbox(first)).toMatchObject({ outcome: 'APPLIED' });
    expect(await parked(second)).toMatchObject({ awaiting_kind: 'FX_RATE', awaiting_ref: secondRate, resolved_at: null });

    await send(conversionQuote(secondRate));
    expect(await inbox(second)).toMatchObject({ outcome: 'APPLIED' });
    expect((await parked(second)).resolved_at).not.toBeNull();
    expect(await reservation(invoice.id)).toMatchObject({ released_original_amount: '2790.7200' });
    await expectReconciled(programId);
  });
});