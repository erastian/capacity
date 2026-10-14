import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { EventPublisher } from '../../src/outbox/event-publisher.js';
import { InboundProcessor } from '../../src/treasury/inbound.processor.js';
import { startApp } from '../support/app.js';
import { CapturingPublisher } from '../support/capturing-publisher.js';
import { closeDb, seedProgram, seedRate, unique } from '../support/db.js';
import { token } from '../support/issuer.js';
import { programMessage, quoteMessage } from '../support/treasury-messages.js';

const INVOICE = 'SGD';
const PAYMENT = 'MYR';

const treasury = (type: string, programId: string, payload: Record<string, unknown>) => programMessage({ type, programId, payload });

const conversionQuote = (rateId: string, rate: string) => quoteMessage({ rateId, from: PAYMENT, to: INVOICE, rateType: 'CONVERSION', rate });

describe('read API', () => {
  let app: NestFastifyApplication;
  let processor: InboundProcessor;
  const acme = unique('C-ACME');
  const globex = unique('C-GLOBEX');
  const bearer: Record<'origination' | 'otherWriter' | 'operator' | 'acme' | 'globex', string> = {} as never;
  let programA: string;
  let programB: string;
  let conversionRateId: string;

  beforeAll(async () => {
    app = await startApp(undefined, (builder) => builder.overrideProvider(EventPublisher).useValue(new CapturingPublisher()));
    processor = app.get(InboundProcessor);
    bearer.origination = await token({ claims: { sub: 'svc-origination', scope: 'reservations:write programs:read:all' } });
    bearer.otherWriter = await token({ claims: { sub: 'svc-other-channel', scope: 'reservations:write programs:read:all' } });
    bearer.operator = await token({ claims: { sub: 'operator', scope: 'programs:read:all breaks:read' } });
    bearer.acme = await token({ claims: { sub: 'buyer-acme', scope: 'programs:read:own', client_ref: acme } });
    bearer.globex = await token({ claims: { sub: 'buyer-globex', scope: 'programs:read:own', client_ref: globex } });

    await seedRate({ from: INVOICE, to: 'EUR', rate: '0.6875' });
    conversionRateId = unique('R');
    await processor.process(conversionQuote(conversionRateId, '0.2915'));
    programA = await seedProgram({ clientRef: acme, creditLimit: '10000' });
    programB = await seedProgram({ clientRef: globex, creditLimit: '10000' });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const get = (who: keyof typeof bearer, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${bearer[who]}` } });

  const reserve = async (programId: string, amount = '1000.00', who: keyof typeof bearer = 'origination') => {
    const invoiceId = unique('INV');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/reservations',
      headers: { authorization: `Bearer ${bearer[who]}`, 'idempotency-key': unique('key') },
      payload: { programId, invoiceId, amount, currency: INVOICE, dueDate: '2099-12-31' },
    });
    return { res, invoiceId, id: res.statusCode === 201 ? (res.json().id as string) : undefined };
  };

  const send = (type: string, programId: string, payload: Record<string, unknown>) => processor.process(treasury(type, programId, payload));

  describe('programmes', () => {
    it('shows a buyer only its own programmes', async () => {
      const acmePrograms = (await get('acme', '/v1/programs?limit=200')).json();
      expect(acmePrograms.items.map((item: { programId: string }) => item.programId)).toEqual([programA]);
      expect(acmePrograms.items[0]).toMatchObject({ clientRef: acme, currency: 'EUR', status: 'ACTIVE', onHold: false });
      const globexPrograms = (await get('globex', '/v1/programs?limit=200')).json();
      expect(globexPrograms.items.map((item: { programId: string }) => item.programId)).toEqual([programB]);
    });

    it('pages through programmes without gaps or repeats', async () => {
      const first = (await get('operator', '/v1/programs?limit=1')).json();
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = (await get('operator', `/v1/programs?limit=1&cursor=${first.nextCursor}`)).json();
      expect(second.items).toHaveLength(1);
      expect(second.items[0].programId > first.items[0].programId).toBe(true);
    });

    it('splits the reserved capacity into committed and funded', async () => {
      const programId = await seedProgram({ clientRef: acme, creditLimit: '1000' });
      const funded = await reserve(programId, '400.00');
      await reserve(programId, '200.00');
      await send('INVOICE_FUNDED', programId, { invoiceId: funded.invoiceId, fundingRef: unique('F') });

      const res = await get('acme', `/v1/programs/${programId}/availability`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        programId,
        currency: 'EUR',
        creditLimit: '1000.0000',
        reserved: '412.5000',
        funded: '275.0000',
        committed: '137.5000',
        totalUtilized: '412.5000',
        available: '587.5000',
        overLimit: '0.0000',
      });
    });

    it('answers a foreign or unknown programme with 404', async () => {
      expect((await get('globex', `/v1/programs/${programA}/availability`)).json()).toMatchObject({ status: 404, code: 'PROGRAM_NOT_FOUND' });
      expect((await get('operator', `/v1/programs/${unique('P')}/availability`)).statusCode).toBe(404);
    });
  });

  describe('reservations', () => {
    it('lists newest first with a cursor and filters', async () => {
      const programId = await seedProgram({ clientRef: acme, creditLimit: '10000' });
      const created = [await reserve(programId, '10.00'), await reserve(programId, '20.00'), await reserve(programId, '30.00')];

      const first = (await get('acme', `/v1/reservations?programId=${programId}&limit=2`)).json();
      expect(first.items.map((item: { id: string }) => item.id)).toEqual([created[2]!.id, created[1]!.id]);
      const rest = (await get('acme', `/v1/reservations?programId=${programId}&limit=2&cursor=${first.nextCursor}`)).json();
      expect(rest).toEqual({ items: [expect.objectContaining({ id: created[0]!.id })], nextCursor: null });

      const byInvoice = (await get('origination', `/v1/reservations?invoiceId=${created[1]!.invoiceId}`)).json();
      expect(byInvoice.items).toHaveLength(1);
      expect(byInvoice.items[0]).toMatchObject({
        id: created[1]!.id,
        status: 'ACTIVE',
        original: { amount: '20.00', currency: INVOICE },
        capacity: { amount: '13.7500', currency: 'EUR' },
        outstanding: { amount: '20.00', currency: INVOICE },
        funding: null,
      });

      expect((await get('acme', `/v1/reservations?programId=${programId}&status=RELEASED`)).json().items).toEqual([]);
    });

    it('keeps buyers apart', async () => {
      const { invoiceId, id } = await reserve(programA, '10.00');
      expect((await get('globex', `/v1/reservations?programId=${programA}`)).json()).toMatchObject({ status: 404 });
      expect((await get('globex', `/v1/reservations?invoiceId=${invoiceId}`)).json().items).toEqual([]);
      expect((await get('globex', `/v1/reservations/${id}`)).json()).toMatchObject({ status: 404, code: 'RESERVATION_NOT_FOUND' });
      expect((await get('globex', `/v1/reservations/${id}/payoff-quote`)).statusCode).toBe(404);
      expect((await get('acme', `/v1/reservations/not-a-uuid`)).statusCode).toBe(404);
    });

    it('rejects a malformed cursor and unknown parameters', async () => {
      expect((await get('operator', '/v1/reservations?cursor=bm9wZQ')).json()).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((await get('operator', '/v1/reservations?sort=amount')).json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('reservation card', () => {
    it('shows payments as they were paid, with the rate and the debt they settled', async () => {
      const { id, invoiceId } = await reserve(programA);
      const fundingRef = unique('F');
      await send('INVOICE_FUNDED', programA, { invoiceId, fundingRef });
      await send('INVOICE_PAYMENT_ALLOCATED', programA, {
        invoiceId,
        allocationId: 'A-1',
        paymentId: 'PAY-1',
        payment: { amount: '100.00', currency: PAYMENT },
        settledAmount: { amount: '29.15', currency: INVOICE },
        fxRateId: conversionRateId,
      });
      await send('INVOICE_BALANCE_WRITTEN_OFF', programA, {
        invoiceId,
        writeOffId: 'W-1',
        amount: { amount: '0.85', currency: INVOICE },
        writeOffReason: 'BANK_CHARGES',
      });
      await send('INVOICE_FUNDING_RETURNED', programA, { invoiceId, fundingRef: 'F-UNKNOWN' });
      await send('INVOICE_PAYMENT_ALLOCATED', programA, {
        invoiceId,
        allocationId: 'A-2',
        paymentId: 'PAY-2',
        payment: { amount: '50.00', currency: PAYMENT },
        settledAmount: { amount: '14.57', currency: INVOICE },
        fxRateId: unique('R'),
      });

      const card = (await get('acme', `/v1/reservations/${id}`)).json();
      expect(card).toMatchObject({
        id,
        status: 'PARTIALLY_RELEASED',
        outstanding: { amount: '970.00', currency: INVOICE },
        funding: { fundedAt: expect.any(String) },
      });
      expect(card.funding.fundingRef).toBeUndefined();
      expect(card.breaks).toBeUndefined();
      expect(card.movements).toEqual([
        expect.objectContaining({
          kind: 'REPAYMENT',
          externalRef: 'A-1',
          amount: { amount: '29.15', currency: INVOICE },
          payment: { id: 'PAY-1', amount: { amount: '100.00', currency: PAYMENT }, fx: { rateId: conversionRateId, rate: '0.2915' } },
          outstandingAfter: { amount: '970.85', currency: INVOICE },
        }),
        expect.objectContaining({
          kind: 'WRITE_OFF',
          externalRef: 'W-1',
          amount: { amount: '0.85', currency: INVOICE },
          reason: 'BANK_CHARGES',
          outstandingAfter: { amount: '970.00', currency: INVOICE },
        }),
      ]);
      expect(card.pending).toEqual([
        expect.objectContaining({
          type: 'INVOICE_PAYMENT_ALLOCATED',
          externalRef: 'A-2',
          amount: { amount: '14.57', currency: INVOICE },
          payment: { amount: '50.00', currency: PAYMENT },
          awaiting: { kind: 'FX_RATE', ref: expect.any(String) },
        }),
      ]);

      const operatorCard = (await get('operator', `/v1/reservations/${id}`)).json();
      expect(operatorCard.funding.fundingRef).toBe(fundingRef);
      expect(operatorCard.breaks).toEqual([expect.objectContaining({ reason: 'FUNDING_CONFLICT', blocking: false })]);
    });
  });

  describe('payoff quote', () => {
    it('quotes the outstanding in the invoice currency and converts at the current quote', async () => {
      const { id, invoiceId } = await reserve(programA);
      await send('INVOICE_PAYMENT_ALLOCATED', programA, {
        invoiceId,
        allocationId: 'A-1',
        paymentId: 'PAY-1',
        payment: { amount: '29.15', currency: INVOICE },
        settledAmount: { amount: '29.15', currency: INVOICE },
      });

      expect((await get('acme', `/v1/reservations/${id}/payoff-quote`)).json()).toMatchObject({
        outstanding: { amount: '970.85', currency: INVOICE },
        payoff: { amount: '970.85', currency: INVOICE },
        fx: null,
      });
      expect((await get('acme', `/v1/reservations/${id}/payoff-quote?currency=${PAYMENT}`)).json()).toMatchObject({
        payoff: { amount: '3330.54', currency: PAYMENT },
        fx: { rateId: conversionRateId, rate: '0.2915' },
      });
    });

    it('refuses a currency without a quote or outside ISO 4217', async () => {
      const { id } = await reserve(programA, '10.00');
      expect((await get('acme', `/v1/reservations/${id}/payoff-quote?currency=CHF`)).json()).toMatchObject({
        status: 422,
        code: 'FX_RATE_UNAVAILABLE',
      });
      expect((await get('acme', `/v1/reservations/${id}/payoff-quote?currency=XXX`)).json()).toMatchObject({
        status: 422,
        code: 'VALIDATION_FAILED',
      });
    });
  });

  describe('declines', () => {
    it('shows a writer its own decisions on an invoice and nobody else', async () => {
      const programId = await seedProgram({ clientRef: acme, creditLimit: '10' });
      const { res, invoiceId } = await reserve(programId);
      expect(res.statusCode).toBe(409);

      const own = (await get('origination', `/v1/declines?invoiceId=${invoiceId}`)).json();
      expect(own.items).toEqual([
        expect.objectContaining({
          programId,
          invoiceId,
          requested: { amount: '1000.00', currency: INVOICE },
          code: 'INSUFFICIENT_CAPACITY',
        }),
      ]);
      expect((await get('otherWriter', `/v1/declines?invoiceId=${invoiceId}`)).json().items).toEqual([]);
      expect((await get('operator', `/v1/declines?invoiceId=${invoiceId}`)).statusCode).toBe(403);
      expect((await get('origination', '/v1/declines')).json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('fx rates', () => {
    it('shows the current quote of a pair to bank roles only', async () => {
      const res = (await get('operator', `/v1/fx-rates?from=${INVOICE}&to=EUR&type=VALUATION`)).json();
      expect(res.items).toEqual([expect.objectContaining({ from: INVOICE, to: 'EUR', rateType: 'VALUATION', status: 'ACTIVE', rate: '0.6875' })]);
      expect((await get('acme', '/v1/fx-rates')).statusCode).toBe(403);
    });
  });
});
