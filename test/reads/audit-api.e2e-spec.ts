import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { EventPublisher } from '../../src/outbox/event-publisher.js';
import { InboundProcessor } from '../../src/treasury/inbound.processor.js';
import { startApp } from '../support/app.js';
import { CapturingPublisher } from '../support/capturing-publisher.js';
import { closeDb, db, unique } from '../support/db.js';
import { token } from '../support/issuer.js';
import { programMessage } from '../support/treasury-messages.js';

function treasury(type: string, programId: string, payload: Record<string, unknown>, version?: number) {
  const raw = programMessage({ type, programId, payload, version });
  return { messageId: raw.messageId, raw };
}

const snapshotPayload = (limitCurrency = 'EUR') => ({
  currency: 'EUR',
  clientRef: 'C-AUDIT',
  creditLimit: { amount: '100', currency: limitCurrency, version: 5 },
  externalUtilized: { amount: '0', currency: 'EUR', version: 1 },
  status: { value: 'ACTIVE', version: 1 },
});

describe('audit and break journals', () => {
  let app: NestFastifyApplication;
  let processor: InboundProcessor;
  const bearer: Record<'auditor' | 'operator' | 'buyer' | 'origination', string> = {} as never;
  const programId = unique('P');
  let reservationId: string;
  let conflictMessage: string;
  let parkedMessage: string;
  const [firstFunding, secondFunding] = [unique('F'), unique('F')];

  const send = async (type: string, target: string, payload: Record<string, unknown>, version?: number) => {
    const { messageId, raw } = treasury(type, target, payload, version);
    await processor.process(raw);
    return messageId;
  };

  const get = (who: keyof typeof bearer, url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer[who]}` } });

  const reserve = (amount: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/reservations',
      headers: { authorization: `Bearer ${bearer.origination}`, 'idempotency-key': unique('key') },
      payload: { programId, invoiceId: unique('INV'), amount, currency: 'EUR', dueDate: '2099-12-31' },
    });

  beforeAll(async () => {
    app = await startApp(undefined, (builder) =>
      builder.overrideProvider(EventPublisher).useValue(new CapturingPublisher()),
    );
    processor = app.get(InboundProcessor);
    bearer.auditor = await token({ claims: { sub: 'auditor', scope: 'programs:read:all breaks:read audit:read' } });
    bearer.operator = await token({ claims: { sub: 'operator', scope: 'programs:read:all breaks:read' } });
    bearer.buyer = await token({ claims: { sub: 'buyer', scope: 'programs:read:own', client_ref: 'C-AUDIT' } });
    bearer.origination = await token({ claims: { sub: 'svc-origination', scope: 'reservations:write programs:read:all' } });

    await send('PROGRAM_SNAPSHOT', programId, snapshotPayload());
    const created = await reserve('40.00');
    reservationId = created.json().id;
    const invoiceId = created.json().invoiceId;
    await send('INVOICE_FUNDED', programId, { invoiceId, fundingRef: firstFunding });
    await send('INVOICE_FUNDING_RETURNED', programId, { invoiceId, fundingRef: firstFunding });
    await send('INVOICE_FUNDED', programId, { invoiceId, fundingRef: secondFunding });
    expect((await reserve('70.00')).statusCode).toBe(409);
    conflictMessage = await send('LIMIT_UPDATED', programId, { creditLimit: { amount: '90', currency: 'EUR' } }, 5);
    parkedMessage = await send('INVOICE_PAYMENT_ALLOCATED', programId, {
      invoiceId,
      allocationId: 'A-1',
      paymentId: 'PAY-1',
      payment: { amount: '10.00', currency: 'CAD' },
      settledAmount: { amount: '7.00', currency: 'EUR' },
      fxRateId: unique('R'),
    });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  describe('breaks', () => {
    it('lists the breaks of a programme to operators', async () => {
      const res = (await get('operator', `/v1/programs/${programId}/breaks`)).json();
      expect(res.items).toEqual([
        expect.objectContaining({ programId, reason: 'VERSION_CONFLICT', blocking: true, messageId: conflictMessage, resolvedAt: null }),
      ]);
      expect(res.items[0].details.essence).toBeUndefined();
      expect((await get('operator', `/v1/programs/${programId}/breaks?open=false`)).json().items).toEqual([]);
      expect((await get('operator', `/v1/breaks?programId=${programId}&reason=VERSION_CONFLICT`)).json().items).toHaveLength(1);
    });

    it('shows breaks of a programme that does not exist yet by its external id', async () => {
      const orphan = unique('P');
      await send('PROGRAM_SNAPSHOT', orphan, snapshotPayload('USD'));
      expect((await get('operator', `/v1/breaks?programId=${orphan}`)).json().items).toEqual([
        expect.objectContaining({ programId: orphan, reason: 'CURRENCY_MISMATCH', blocking: false }),
      ]);
      expect((await get('operator', `/v1/programs/${orphan}/breaks`)).statusCode).toBe(404);
    });

    it('keeps breaks from buyers', async () => {
      expect((await get('buyer', `/v1/programs/${programId}/breaks`)).statusCode).toBe(403);
      expect((await get('buyer', '/v1/breaks')).statusCode).toBe(403);
    });
  });

  describe('audit journals', () => {
    it('shows the ledger newest first with balances after each entry', async () => {
      const res = (await get('auditor', `/v1/audit/ledger?programId=${programId}`)).json();
      expect(res.items).toEqual([
        expect.objectContaining({
          type: 'RESERVE',
          delta: { creditLimit: '0.0000', externalUtilized: '0.0000', reserved: '40.0000' },
          after: { creditLimit: '100.0000', externalUtilized: '0.0000', reserved: '40.0000' },
          currency: 'EUR',
          reservationId,
        }),
        expect.objectContaining({ type: 'TREASURY_SNAPSHOT', after: expect.objectContaining({ creditLimit: '100.0000' }) }),
      ]);
      expect((await get('auditor', `/v1/audit/ledger?programId=${unique('P')}`)).statusCode).toBe(404);
    });

    it('filters and pages the inbox', async () => {
      const rejected = (await get('auditor', `/v1/audit/inbox?programId=${programId}&outcome=REJECTED`)).json();
      expect(rejected.items).toEqual([
        expect.objectContaining({ messageId: conflictMessage, type: 'LIMIT_UPDATED', reason: 'VERSION_CONFLICT', version: '5' }),
      ]);

      const first = (await get('auditor', `/v1/audit/inbox?programId=${programId}&limit=2`)).json();
      const second = (await get('auditor', `/v1/audit/inbox?programId=${programId}&limit=2&cursor=${first.nextCursor}`)).json();
      const seen = [...first.items, ...second.items].map((item: { messageId: string }) => item.messageId);
      expect(new Set(seen).size).toBe(4);
    });

    it('shows what the parked messages wait for', async () => {
      const res = (await get('auditor', `/v1/audit/parked?programId=${programId}&unresolved=true`)).json();
      expect(res.items).toEqual([
        expect.objectContaining({
          messageId: parkedMessage,
          reservationId,
          awaiting: { kind: 'FX_RATE', ref: expect.any(String) },
          envelope: expect.objectContaining({ type: 'INVOICE_PAYMENT_ALLOCATED' }),
          resolvedAt: null,
        }),
      ]);
    });

    it('lists the funding history of a reservation', async () => {
      const res = (await get('auditor', `/v1/audit/fundings?reservationId=${reservationId}`)).json();
      expect(res.items).toEqual([
        expect.objectContaining({ fundingRef: secondFunding, returnedAt: null }),
        expect.objectContaining({ fundingRef: firstFunding, returnedAt: expect.any(String) }),
      ]);
      expect((await get('auditor', `/v1/audit/fundings?reservationId=${randomUUID()}`)).statusCode).toBe(404);
      expect((await get('auditor', '/v1/audit/fundings?reservationId=nope')).json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('shows the outbox by programme, type and publication', async () => {
      const created = (await get('auditor', `/v1/audit/outbox?programId=${programId}&type=RESERVATION_CREATED`)).json();
      expect(created.items).toEqual([expect.objectContaining({ type: 'RESERVATION_CREATED', partitionKey: programId })]);

      await db().query('UPDATE outbox_event SET published_at = now() WHERE event_id = $1', [created.items[0].eventId]);
      const unpublished = (await get('auditor', `/v1/audit/outbox?programId=${programId}&unpublished=true&limit=200`)).json();
      expect(unpublished.items.every((item: { publishedAt: string | null }) => item.publishedAt === null)).toBe(true);
      expect(unpublished.items.map((item: { eventId: string }) => item.eventId)).not.toContain(created.items[0].eventId);
    });

    it('keeps the full decline journal for auditors', async () => {
      const res = (await get('auditor', `/v1/audit/declines?programId=${programId}&code=INSUFFICIENT_CAPACITY`)).json();
      expect(res.items).toEqual([
        expect.objectContaining({ requested: { amount: '70.00', currency: 'EUR' }, createdBy: 'svc-origination' }),
      ]);
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
      expect((await get('auditor', `/v1/audit/declines?programId=${programId}&from=${tomorrow}`)).json().items).toEqual([]);
    });

    it.each(['2026-W01', '2026-001', '2026-01-01T00:00:00', '2026-02-30T00:00:00Z'])(
      'rejects %s as a decline journal bound',
      async (from) => {
        const res = await get('auditor', `/v1/audit/declines?from=${from}`);
        expect(res.statusCode).toBe(422);
        expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
      },
    );

    it('is closed to everyone without audit:read', async () => {
      for (const path of ['ledger?programId=P', 'inbox', 'parked', `fundings?reservationId=${reservationId}`, 'outbox', 'declines']) {
        expect((await get('operator', `/v1/audit/${path}`)).statusCode).toBe(403);
      }
    });
  });
});