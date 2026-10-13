import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { EventPublisher } from '../../src/outbox/event-publisher.js';
import type { RawMessage } from '../../src/treasury/adapter/envelope.types.js';
import { InboundProcessor } from '../../src/treasury/inbound.processor.js';
import { startApp } from '../support/app.js';
import { CapturingPublisher } from '../support/capturing-publisher.js';
import { closeDb, db, seedProgram, unique } from '../support/db.js';
import { token } from '../support/issuer.js';
import type { QuoteInput } from '../support/support.types.js';

let offset = 0n;
let version = BigInt(Date.now()) * 1000n;

function quote(input: QuoteInput = {}): RawMessage & { messageId: string; rateId: string } {
  const messageId = input.messageId ?? unique('m');
  const rateId = input.rateId ?? unique('R');
  const from = input.from ?? 'USD';
  const to = input.to ?? 'EUR';
  const rateType = input.rateType ?? 'VALUATION';
  const asOf = new Date(Date.now() - (input.ageSeconds ?? 1) * 1000);
  return {
    messageId,
    rateId,
    topic: 'treasury.fx-rates',
    partition: 0,
    offset: offset++,
    key: `${from}:${to}:${rateType}`,
    value: JSON.stringify({
      messageId,
      type: 'FX_RATE_PUBLISHED',
      schemaVersion: 1,
      version: (input.version ?? ++version).toString(),
      asOf: asOf.toISOString(),
      payload: {
        rateId,
        from,
        to,
        rateType,
        status: input.status ?? 'ACTIVE',
        ...(input.rate === null ? {} : { rate: input.rate ?? '0.92' }),
      },
    }),
    timestamp: asOf,
  };
}

describe('treasury FX quotes', () => {
  let app: NestFastifyApplication;
  let processor: InboundProcessor;

  beforeAll(async () => {
    app = await startApp(undefined, (builder) =>
      builder.overrideProvider(EventPublisher).useValue(new CapturingPublisher()),
    );
    processor = app.get(InboundProcessor);
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const inbox = async (messageId: string) =>
    (
      await db().query(
        'SELECT type::text AS type, outcome::text AS outcome, reason, program_id FROM processed_message WHERE message_id = $1',
        [messageId],
      )
    ).rows[0];

  const stored = async (rateId: string) =>
    (
      await db().query(
        'SELECT from_currency, to_currency, rate_type::text AS rate_type, rate, status::text AS status FROM fx_rate WHERE external_id = $1',
        [rateId],
      )
    ).rows[0];

  const statuses = async (messageId: string) =>
    (
      await db().query(
        `SELECT partition_key, payload -> 'data' AS data FROM outbox_event
         WHERE type = 'INBOUND_MESSAGE_STATUS' AND payload -> 'data' ->> 'messageId' = $1 ORDER BY id`,
        [messageId],
      )
    ).rows;

  const reserve = async (programId: string, currency: string) => {
    const bearer = await token({ claims: { scope: 'reservations:write programs:read:all' } });
    return app.inject({
      method: 'POST',
      url: '/v1/reservations',
      headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': unique('key') },
      payload: { programId, invoiceId: unique('INV'), amount: '100.00', currency, dueDate: '2099-01-01' },
    });
  };

  it('stores a quote exactly and without a programme', async () => {
    const message = quote({ from: 'MXN', to: 'EUR', rate: '0.050000000000000001' });
    await processor.process(message);

    expect(await inbox(message.messageId)).toEqual({
      type: 'FX_RATE_PUBLISHED',
      outcome: 'APPLIED',
      reason: null,
      program_id: null,
    });
    expect(await stored(message.rateId)).toEqual({
      from_currency: 'MXN',
      to_currency: 'EUR',
      rate_type: 'VALUATION',
      rate: '0.050000000000000001',
      status: 'ACTIVE',
    });
  });

  it('keeps a late quote without making it current', async () => {
    const current = quote({ from: 'PLN', to: 'EUR', rate: '0.23' });
    const late = quote({ from: 'PLN', to: 'EUR', rate: '0.22', version: 1n });
    await processor.process(current);
    await processor.process(late);

    expect(await inbox(late.messageId)).toMatchObject({ outcome: 'APPLIED' });
    const programId = await seedProgram({ currency: 'EUR' });
    const res = await reserve(programId, 'PLN');
    expect(res.json()).toMatchObject({ fxRateId: current.rateId, amount: '23.0000' });
  });

  it('answers the same quote resent under a new message as STALE', async () => {
    const first = quote({ from: 'HUF', to: 'EUR' });
    const again = { ...first, messageId: unique('m'), offset: offset++ };
    again.value = JSON.stringify({ ...JSON.parse(first.value!), messageId: again.messageId });
    await processor.process(first);
    await processor.process(again);

    expect(await inbox(again.messageId)).toMatchObject({ outcome: 'STALE' });
  });

  it.each<[string, (rateId: string, version: bigint) => QuoteInput]>([
    ['the same rateId with another rate', (rateId, v) => ({ rateId, version: v, rate: '0.99' })],
    ['another rateId for the same version of the pair', (_, v) => ({ version: v })],
  ])('rejects %s as FX_RATE_CONFLICT', async (_, conflicting) => {
    const original = quote({ from: 'CZK', to: 'EUR' });
    const v = BigInt(JSON.parse(original.value!).version);
    await processor.process(original);
    const clash = quote({ from: 'CZK', to: 'EUR', ...conflicting(original.rateId, v) });
    await processor.process(clash);

    expect(await inbox(clash.messageId)).toMatchObject({ outcome: 'REJECTED', reason: 'FX_RATE_CONFLICT' });
    const [status] = await statuses(clash.messageId);
    expect(status.partition_key).toBe('CZK:EUR:VALUATION');
    expect(status.data).toMatchObject({ status: 'RJCT', reason: 'FX_RATE_CONFLICT' });
  });

  it('suspends the instrument for new reservations', async () => {
    await processor.process(quote({ from: 'RON', to: 'EUR', rate: '0.2' }));
    await processor.process(quote({ from: 'RON', to: 'EUR', status: 'SUSPENDED', rate: null }));

    const programId = await seedProgram({ currency: 'EUR' });
    expect((await reserve(programId, 'RON')).json()).toMatchObject({ code: 'FX_RATE_SUSPENDED' });
  });

  it('reports a quote that is too old as stale for reservations', async () => {
    await processor.process(quote({ from: 'BGN', to: 'EUR', rate: '0.51', ageSeconds: 7 * 3600 }));
    const programId = await seedProgram({ currency: 'EUR' });
    expect((await reserve(programId, 'BGN')).json()).toMatchObject({ code: 'FX_RATE_STALE' });
  });

  it('rejects a malformed quote as INVALID_FORMAT', async () => {
    const message = quote({ rate: '0.0000000000000000001' });
    await processor.process(message);
    expect(await inbox(message.messageId)).toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_FORMAT' });
  });
});