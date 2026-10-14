import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { businessDate } from '../../src/shared/time/clock.js';
import { startApp } from '../support/app.js';
import { closeDb, db, seedProgram, seedRate, unique } from '../support/db.js';
import { token } from '../support/issuer.js';

const ORIGINATION = { sub: 'svc-origination', azp: 'origination', scope: 'reservations:write programs:read:all' };

const today = () => businessDate(new Date(), 'Europe/London');
const shiftDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

describe('POST /v1/reservations', () => {
  let app: NestFastifyApplication;
  let bearer: string;

  beforeAll(async () => {
    app = await startApp();
    bearer = await token({ claims: ORIGINATION });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const reserve = (
    body: Record<string, unknown>,
    key: string | null = unique('key'),
    auth = bearer,
  ) =>
    app.inject({
      method: 'POST',
      url: '/v1/reservations',
      headers: {
        authorization: `Bearer ${auth}`,
        ...(key ? { 'idempotency-key': key } : {}),
      },
      payload: body,
    });

  const request = (programId: string, patch: Record<string, unknown> = {}) => ({
    programId,
    invoiceId: unique('INV'),
    amount: '100.00',
    currency: 'EUR',
    dueDate: shiftDays(today(), 30),
    ...patch,
  });

  const programRow = async (externalId: string) =>
    (await db().query('SELECT * FROM program WHERE external_id = $1', [externalId])).rows[0];

  const outboxFor = async (externalId: string) =>
    (
      await db().query(
        `SELECT type::text AS type, partition_key, payload FROM outbox_event o
         JOIN program p ON p.id = o.program_id WHERE p.external_id = $1 ORDER BY o.id`,
        [externalId],
      )
    ).rows;

  describe('reserves', () => {
    it('in the program currency', async () => {
      const programId = await seedProgram({ creditLimit: '1000', externalUtilized: '200' });
      const body = request(programId, { amount: '100' });
      const res = await reserve(body);

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        programId,
        invoiceId: body.invoiceId,
        status: 'ACTIVE',
        originalAmount: '100.00',
        originalCurrency: 'EUR',
        amount: '100.0000',
        currency: 'EUR',
        fxRateId: null,
        outstanding: '100.00',
        capacityOutstanding: '100.0000',
        program: { available: '700.0000', reserved: '100.0000', currency: 'EUR' },
      });

      const program = await programRow(programId);
      expect(program.reserved).toBe('100.0000');

      const ledger = await db().query(
        `SELECT type::text AS type, reserved_delta, reserved_after, credit_limit_after, external_utilized_after
         FROM capacity_ledger WHERE program_id = $1`,
        [program.id],
      );
      expect(ledger.rows).toEqual([
        {
          type: 'RESERVE',
          reserved_delta: '100.0000',
          reserved_after: '100.0000',
          credit_limit_after: '1000.0000',
          external_utilized_after: '200.0000',
        },
      ]);

      const outbox = await outboxFor(programId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ type: 'RESERVATION_CREATED', partition_key: programId });
      expect(outbox[0].payload).toMatchObject({
        schemaVersion: 1,
        type: 'RESERVATION_CREATED',
        data: {
          reservationId: res.json().id,
          invoiceId: body.invoiceId,
          programId,
          reservedAfter: res.json().program.reserved,
          available: res.json().program.available,
        },
      });
      expect(outbox[0].payload.data).not.toHaveProperty('program');
    });

    it('in another currency through the valuation rate, rounding up', async () => {
      const programId = await seedProgram({ currency: 'EUR' });
      const rateId = await seedRate({ from: 'USD', to: 'EUR', rate: '0.333333' });
      const res = await reserve(request(programId, { amount: '100.01', currency: 'USD' }));

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        originalAmount: '100.01',
        originalCurrency: 'USD',
        amount: '33.3367',
        currency: 'EUR',
        fxRateId: rateId,
      });
    });

    it('a zero-decimal currency', async () => {
      const programId = await seedProgram({ currency: 'JPY', creditLimit: '1000000' });
      const res = await reserve(request(programId, { amount: '125000', currency: 'JPY' }));
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ originalAmount: '125000', amount: '125000.0000' });
    });

    it('on the due date itself', async () => {
      const programId = await seedProgram();
      expect((await reserve(request(programId, { dueDate: today() }))).statusCode).toBe(201);
    });
  });

  describe('is idempotent', () => {
    it('replays the stored response for the same key and body', async () => {
      const programId = await seedProgram();
      const key = unique('key');
      const body = request(programId);
      const first = await reserve(body, key);
      const second = await reserve({ ...body, amount: '100' }, key);

      expect(second.statusCode).toBe(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.json()).toEqual(first.json());
      expect((await programRow(programId)).reserved).toBe('100.0000');
    });

    it('rejects the same key with a different body', async () => {
      const programId = await seedProgram();
      const key = unique('key');
      await reserve(request(programId), key);
      const res = await reserve(request(programId), key);

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });

    it('replays business errors too', async () => {
      const key = unique('key');
      const body = request('P-missing');
      const first = await reserve(body, key);
      const second = await reserve(body, key);

      expect(first.statusCode).toBe(404);
      expect(second.statusCode).toBe(404);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.json()).toEqual(first.json());
    });

    it('does not store validation errors, so a corrected request may reuse the key', async () => {
      const programId = await seedProgram();
      const key = unique('key');
      const invalid = await reserve(request(programId, { amount: '10.001' }), key);
      const valid = await reserve(request(programId), key);

      expect(invalid.statusCode).toBe(422);
      expect(valid.statusCode).toBe(201);
    });
  });

  it('answers a repeated invoice with the existing reservation', async () => {
    const programId = await seedProgram();
    const body = request(programId);
    const first = await reserve(body);
    const second = await reserve(body);

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      code: 'INVOICE_ALREADY_RESERVED',
      reservation: { id: first.json().id, status: 'ACTIVE', programId, invoiceId: body.invoiceId },
    });
  });

  it('answers 404 for an unknown program', async () => {
    const res = await reserve(request('P-does-not-exist'));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'PROGRAM_NOT_FOUND' });
  });

  describe('declines and records the credit decision', () => {
    it.each<[string, () => Promise<{ programId: string; patch?: Record<string, unknown> }>, number, string]>([
      ['past due', async () => ({ programId: await seedProgram(), patch: { dueDate: shiftDays(today(), -1) } }), 422, 'INVOICE_PAST_DUE'],
      ['suspended', async () => ({ programId: await seedProgram({ status: 'SUSPENDED' }) }), 409, 'PROGRAM_SUSPENDED'],
      ['closed', async () => ({ programId: await seedProgram({ status: 'CLOSED' }) }), 409, 'PROGRAM_CLOSED'],
      ['on hold', async () => ({ programId: await seedProgram({ openBlockingBreaks: 1 }) }), 409, 'PROGRAM_ON_HOLD'],
      ['no rate', async () => ({ programId: await seedProgram({ currency: 'CHF' }), patch: { currency: 'NOK' } }), 422, 'FX_RATE_UNAVAILABLE'],
      ['suspended rate', async () => {
        await seedRate({ from: 'SEK', to: 'EUR', status: 'SUSPENDED' });
        return { programId: await seedProgram(), patch: { currency: 'SEK' } };
      }, 422, 'FX_RATE_SUSPENDED'],
      ['stale rate', async () => {
        await seedRate({ from: 'DKK', to: 'EUR', rate: '0.13', ageSeconds: 7 * 3600 });
        return { programId: await seedProgram(), patch: { currency: 'DKK' } };
      }, 422, 'FX_RATE_STALE'],
      ['insufficient capacity', async () => ({ programId: await seedProgram({ creditLimit: '50' }) }), 409, 'INSUFFICIENT_CAPACITY'],
    ])('%s', async (_, arrange, status, code) => {
      const { programId, patch } = await arrange();
      const body = request(programId, patch);
      const res = await reserve(body);

      expect(res.statusCode).toBe(status);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json()).toMatchObject({ code, status });

      const program = await programRow(programId);
      expect(program.reserved).toBe('0.0000');

      const declines = await db().query(
        'SELECT code, invoice_id, requested_amount, created_by FROM reservation_decline WHERE program_id = $1',
        [program.id],
      );
      expect(declines.rows).toEqual([
        { code, invoice_id: body.invoiceId, requested_amount: '100.0000', created_by: 'svc-origination' },
      ]);

      const outbox = await outboxFor(programId);
      expect(outbox.map((e) => e.type)).toEqual(['RESERVATION_DECLINED']);
      expect(outbox[0].payload.data).toMatchObject({ code, invoiceId: body.invoiceId });
    });
  });

  describe('rejects the request form with 422 VALIDATION_FAILED', () => {
    it.each<[string, Record<string, unknown>, string | null]>([
      ['missing Idempotency-Key', {}, null],
      ['too short Idempotency-Key', {}, 'short'],
      ['too many decimals for JPY', { amount: '100.5', currency: 'JPY' }, unique('key')],
      ['too many decimals for USD', { amount: '10.001', currency: 'USD' }, unique('key')],
      ['zero amount', { amount: '0' }, unique('key')],
      ['negative amount', { amount: '-5' }, unique('key')],
      ['numeric amount', { amount: 100 }, unique('key')],
      ['unknown currency', { currency: 'XAU' }, unique('key')],
      ['lowercase currency', { currency: 'eur' }, unique('key')],
      ['bad date', { dueDate: '2026-02-30' }, unique('key')],
      ['datetime instead of date', { dueDate: '2026-12-31T00:00:00Z' }, unique('key')],
      ['unknown field', { comment: 'hi' }, unique('key')],
    ])('%s', async (_, patch, key) => {
      const res = await reserve(request('P-any', patch), key);
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  it('requires reservations:write', async () => {
    const client = await token({ claims: { scope: 'programs:read:own', client_ref: 'C-ACME' } });
    const res = await reserve(request('P-any'), unique('key'), client);
    expect(res.statusCode).toBe(403);
  });

  it('needs no read scope besides reservations:write', async () => {
    const writer = await token({ claims: { sub: 'svc-origination', scope: 'reservations:write' } });
    const res = await reserve(request(await seedProgram()), unique('key'), writer);
    expect(res.statusCode).toBe(201);
  });

  describe('under concurrency', () => {
    it('never exceeds the limit', async () => {
      const programId = await seedProgram({ creditLimit: '60' });
      const results = await Promise.all(
        Array.from({ length: 100 }, () => reserve(request(programId, { amount: '1' }))),
      );
      const tally = results.reduce<Record<string, number>>((counts, r) => {
        const key = r.statusCode >= 400 ? `${r.statusCode} ${r.json().code}` : String(r.statusCode);
        return { ...counts, [key]: (counts[key] ?? 0) + 1 };
      }, {});

      expect(tally).toEqual({ '201': 60, '409 INSUFFICIENT_CAPACITY': 40 });

      const program = await programRow(programId);
      expect(program.reserved).toBe('60.0000');

      const ledger = await db().query(
        `SELECT count(*)::int AS entries, max(reserved_after) AS last, sum(reserved_delta) AS total
         FROM capacity_ledger WHERE program_id = $1`,
        [program.id],
      );
      expect(ledger.rows[0]).toEqual({ entries: 60, last: '60.0000', total: '60.0000' });

      const declines = await db().query(
        'SELECT count(*)::int AS n FROM reservation_decline WHERE program_id = $1',
        [program.id],
      );
      expect(declines.rows[0].n).toBe(40);
    });

    it('creates one reservation for parallel retries with the same key', async () => {
      const programId = await seedProgram();
      const key = unique('key');
      const body = request(programId);
      const results = await Promise.all(Array.from({ length: 20 }, () => reserve(body, key)));

      expect(results.every((r) => r.statusCode === 201)).toBe(true);
      expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
      expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(19);
      expect((await programRow(programId)).reserved).toBe('100.0000');
    });

    it('lets one of two keys win the same invoice', async () => {
      const programA = await seedProgram();
      const programB = await seedProgram();
      const invoiceId = unique('INV');
      const [a, b] = await Promise.all([
        reserve(request(programA, { invoiceId })),
        reserve(request(programB, { invoiceId })),
      ]);

      expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
      const loser = a.statusCode === 409 ? a : b;
      expect(loser.json()).toMatchObject({ code: 'INVOICE_ALREADY_RESERVED' });

      const reserved = [(await programRow(programA)).reserved, (await programRow(programB)).reserved].sort();
      expect(reserved).toEqual(['0.0000', '100.0000']);
    });
  });
});