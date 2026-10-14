import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { EventPublisher } from '../../src/outbox/event-publisher.js';
import type { RawMessage } from '../../src/treasury/adapter/envelope.types.js';
import { InboundProcessor } from '../../src/treasury/inbound.processor.js';
import { startApp } from '../support/app.js';
import { CapturingPublisher } from '../support/capturing-publisher.js';
import { closeDb, db, unique } from '../support/db.js';
import { token } from '../support/issuer.js';
import type { ProgramMessageInput as MessageInput } from '../support/support.types.js';

let offset = 0n;

function raw(input: MessageInput | string, key?: string): RawMessage & { messageId: string } {
  const messageId = typeof input === 'string' ? unique('bad') : (input.messageId ?? unique('m'));
  const value =
    typeof input === 'string'
      ? input
      : JSON.stringify({
          messageId,
          type: input.type,
          schemaVersion: input.schemaVersion ?? 1,
          programId: input.programId,
          version: input.version,
          asOf: input.asOf ?? new Date(Date.now() - 1000).toISOString(),
          payload: input.payload ?? {},
        });
  return {
    messageId,
    topic: 'treasury.program-capacity',
    partition: 0,
    offset: offset++,
    key: key ?? (typeof input === 'string' ? null : (input.programId ?? null)),
    value,
    timestamp: typeof input === 'string' ? new Date() : (input.brokerTime ?? new Date()),
  };
}

const amount = (value: string, version: number, currency = 'EUR') => ({ amount: value, currency, version });

const snapshot = (programId: string, patch: Record<string, unknown> = {}): MessageInput => ({
  type: 'PROGRAM_SNAPSHOT',
  programId,
  payload: {
    currency: 'EUR',
    clientRef: 'C-ACME',
    creditLimit: amount('1000', 5),
    externalUtilized: amount('100', 3),
    status: { value: 'ACTIVE', version: 2 },
    ...patch,
  },
});

const limit = (programId: string, value: string, version: number, currency = 'EUR'): MessageInput => ({
  type: 'LIMIT_UPDATED',
  programId,
  version,
  payload: { creditLimit: { amount: value, currency } },
});

describe('treasury program messages', () => {
  let app: NestFastifyApplication;
  let processor: InboundProcessor;
  let publisher: CapturingPublisher;

  beforeAll(async () => {
    publisher = new CapturingPublisher();
    app = await startApp(undefined, (builder) => builder.overrideProvider(EventPublisher).useValue(publisher));
    processor = app.get(InboundProcessor);
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const send = async (input: MessageInput | string, key?: string) => {
    const message = raw(input, key);
    await processor.process(message);
    return message;
  };

  const program = async (externalId: string) =>
    (await db().query('SELECT * FROM program WHERE external_id = $1', [externalId])).rows[0];

  const inbox = async (messageId: string) =>
    (
      await db().query(
        'SELECT type::text AS type, outcome::text AS outcome, reason FROM processed_message WHERE message_id = $1',
        [messageId],
      )
    ).rows[0];

  const statuses = async (messageId: string) =>
    (
      await db().query(
        `SELECT payload -> 'data' AS data FROM outbox_event
         WHERE type = 'INBOUND_MESSAGE_STATUS' AND payload -> 'data' ->> 'messageId' = $1 ORDER BY id`,
        [messageId],
      )
    ).rows.map((row) => row.data);

  const events = async (programId: string, type: string) =>
    (
      await db().query(
        `SELECT payload -> 'data' AS data FROM outbox_event WHERE partition_key = $1 AND type = $2::"OutboundEventType" ORDER BY id`,
        [programId, type],
      )
    ).rows.map((row) => row.data);

  const ledger = async (programUuid: string) =>
    (
      await db().query(
        `SELECT type::text AS type, credit_limit_delta, external_utilized_delta, credit_limit_after, external_utilized_after
         FROM capacity_ledger WHERE program_id = $1 ORDER BY id`,
        [programUuid],
      )
    ).rows;

  const breaks = async (programUuid: string) =>
    (
      await db().query(
        'SELECT reason::text AS reason, blocking, resolved_at FROM program_break WHERE program_id = $1 ORDER BY opened_at',
        [programUuid],
      )
    ).rows;

  describe('snapshots', () => {
    it('create the programme with versions, ledger and freshness', async () => {
      const programId = unique('P');
      const brokerTime = new Date(Date.now() - 5000);
      const asOf = new Date(Date.now() - 60_000);
      const message = await send({ ...snapshot(programId), asOf: asOf.toISOString(), brokerTime });

      const row = await program(programId);
      expect(row).toMatchObject({
        client_ref: 'C-ACME',
        currency: 'EUR',
        credit_limit: '1000.0000',
        credit_limit_version: '5',
        external_utilized: '100.0000',
        external_utilized_version: '3',
        status: 'ACTIVE',
        status_version: '2',
        open_blocking_breaks: 0,
      });
      expect(new Date(row.treasury_synced_at).getTime()).toBe(asOf.getTime());
      expect(await inbox(message.messageId)).toEqual({ type: 'PROGRAM_SNAPSHOT', outcome: 'APPLIED', reason: null });
      expect(await ledger(row.id)).toEqual([
        {
          type: 'TREASURY_SNAPSHOT',
          credit_limit_delta: '1000.0000',
          external_utilized_delta: '100.0000',
          credit_limit_after: '1000.0000',
          external_utilized_after: '100.0000',
        },
      ]);
      expect(await statuses(message.messageId)).toEqual([]);
    });

    it('take freshness from the broker when treasury clocks run ahead', async () => {
      const programId = unique('P');
      const brokerTime = new Date(Date.now() - 2000);
      await send({ ...snapshot(programId), asOf: new Date(Date.now() + 3_600_000).toISOString(), brokerTime });
      expect(new Date((await program(programId)).treasury_synced_at).getTime()).toBe(brokerTime.getTime());
    });

    it('reject a contradictory creating snapshot and keep the break without a programme', async () => {
      const programId = unique('P');
      const message = await send(snapshot(programId, { creditLimit: amount('1000', 5, 'USD') }));

      expect(await program(programId)).toBeUndefined();
      expect(await inbox(message.messageId)).toMatchObject({ outcome: 'REJECTED', reason: 'CURRENCY_MISMATCH' });
      const { rows } = await db().query(
        'SELECT program_id, blocking, reason::text AS reason FROM program_break WHERE program_external_id = $1',
        [programId],
      );
      expect(rows).toEqual([{ program_id: null, blocking: false, reason: 'CURRENCY_MISMATCH' }]);
      expect((await statuses(message.messageId))[0]).toMatchObject({ status: 'RJCT', reason: 'CURRENCY_MISMATCH' });
    });

    it('reject another owner with a blocking break', async () => {
      const programId = unique('P');
      await send(snapshot(programId));
      const message = await send(snapshot(programId, { clientRef: 'C-GLOBEX', creditLimit: amount('2000', 9) }));

      const row = await program(programId);
      expect(row.credit_limit).toBe('1000.0000');
      expect(row.open_blocking_breaks).toBe(1);
      expect(await inbox(message.messageId)).toMatchObject({ outcome: 'REJECTED', reason: 'CLIENT_MISMATCH' });
    });
  });

  describe('limit updates', () => {
    it('apply newer versions, ignore older ones and record the ledger', async () => {
      const programId = unique('P');
      await send(snapshot(programId));
      const newer = await send(limit(programId, '1500', 6));
      const older = await send(limit(programId, '700', 4));

      const row = await program(programId);
      expect(row.credit_limit).toBe('1500.0000');
      expect(row.credit_limit_version).toBe('6');
      expect(await inbox(newer.messageId)).toMatchObject({ outcome: 'APPLIED' });
      expect(await inbox(older.messageId)).toMatchObject({ outcome: 'STALE' });
      expect((await ledger(row.id)).map((entry) => [entry.type, entry.credit_limit_delta])).toEqual([
        ['TREASURY_SNAPSHOT', '1000.0000'],
        ['TREASURY_LIMIT_UPDATED', '500.0000'],
      ]);
    });

    it('open one blocking version conflict, not one per repeat, and stop new reservations', async () => {
      const programId = unique('P');
      await send(snapshot(programId));
      const first = await send(limit(programId, '999', 5));
      const repeat = await send(limit(programId, '998', 5));

      const row = await program(programId);
      expect(row.credit_limit).toBe('1000.0000');
      expect(row.open_blocking_breaks).toBe(1);
      expect(await breaks(row.id)).toEqual([{ reason: 'VERSION_CONFLICT', blocking: true, resolved_at: null }]);
      expect(await inbox(repeat.messageId)).toMatchObject({ outcome: 'REJECTED', reason: 'VERSION_CONFLICT' });

      const [status] = await statuses(first.messageId);
      expect(status).toMatchObject({ status: 'RJCT', reason: 'VERSION_CONFLICT' });
      expect(status.references.breakId).toBeDefined();
      expect(await events(programId, 'PROGRAM_BREAK_OPENED')).toHaveLength(1);

      const bearer = await token({ claims: { scope: 'reservations:write programs:read:all' } });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/reservations',
        headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': unique('key') },
        payload: { programId, invoiceId: unique('INV'), amount: '1.00', currency: 'EUR', dueDate: '2099-01-01' },
      });
      expect(res.json()).toMatchObject({ code: 'PROGRAM_ON_HOLD' });
    });

    it('reject a limit in a foreign currency', async () => {
      const programId = unique('P');
      await send(snapshot(programId));
      const message = await send(limit(programId, '500', 6, 'USD'));
      expect(await inbox(message.messageId)).toMatchObject({ reason: 'CURRENCY_MISMATCH' });
      expect((await program(programId)).open_blocking_breaks).toBe(1);
    });

    it('raise and clear the limit excess', async () => {
      const programId = unique('P');
      await send(snapshot(programId, { creditLimit: amount('100', 5), externalUtilized: amount('50', 3) }));
      await send(limit(programId, '40', 6));
      await send(limit(programId, '200', 7));

      expect(await events(programId, 'PROGRAM_LIMIT_EXCESS_STARTED')).toEqual([
        expect.objectContaining({ overLimit: '10.0000', currency: 'EUR' }),
      ]);
      expect(await events(programId, 'PROGRAM_LIMIT_EXCESS_ENDED')).toHaveLength(1);
    });
  });

  describe('external utilization updates', () => {
    const utilization = (programId: string, value: string, version: number, currency = 'EUR'): MessageInput => ({
      type: 'EXTERNAL_UTILIZATION_UPDATED',
      programId,
      version,
      payload: { externalUtilized: { amount: value, currency } },
    });

    it('apply newer versions, ignore older ones and record the ledger', async () => {
      const programId = unique('P');
      await send(snapshot(programId));
      const newer = await send(utilization(programId, '250', 4));
      const older = await send(utilization(programId, '50', 2));

      const row = await program(programId);
      expect(row.external_utilized).toBe('250.0000');
      expect(row.external_utilized_version).toBe('4');
      expect(await inbox(newer.messageId)).toMatchObject({ outcome: 'APPLIED' });
      expect(await inbox(older.messageId)).toMatchObject({ outcome: 'STALE' });
      expect((await ledger(row.id)).map((entry) => [entry.type, entry.external_utilized_delta])).toEqual([
        ['TREASURY_SNAPSHOT', '100.0000'],
        ['TREASURY_EXTERNAL_UTILIZATION_UPDATED', '150.0000'],
      ]);
    });

    it('raise the limit excess when utilization outgrows the limit', async () => {
      const programId = unique('P');
      await send(snapshot(programId));
      await send(utilization(programId, '1200', 4));
      expect(await events(programId, 'PROGRAM_LIMIT_EXCESS_STARTED')).toEqual([
        expect.objectContaining({ overLimit: '200.0000', currency: 'EUR' }),
      ]);
    });

    it('reject utilization in a foreign currency with a blocking break', async () => {
      const programId = unique('P');
      await send(snapshot(programId));
      const message = await send(utilization(programId, '250', 4, 'USD'));
      expect(await inbox(message.messageId)).toMatchObject({ outcome: 'REJECTED', reason: 'CURRENCY_MISMATCH' });
      expect((await program(programId)).open_blocking_breaks).toBe(1);
    });
  });

  describe('status', () => {
    it('suspends, refuses to reopen a closed programme and reinstates by amendment', async () => {
      const programId = unique('P');
      await send(snapshot(programId));
      await send({ type: 'PROGRAM_STATUS_CHANGED', programId, version: 3, payload: { status: 'SUSPENDED', reason: 'review' } });
      expect((await program(programId)).status).toBe('SUSPENDED');

      await send({ type: 'PROGRAM_STATUS_CHANGED', programId, version: 4, payload: { status: 'CLOSED' } });
      const reopen = await send({ type: 'PROGRAM_STATUS_CHANGED', programId, version: 5, payload: { status: 'ACTIVE' } });
      expect(await inbox(reopen.messageId)).toMatchObject({ outcome: 'REJECTED', reason: 'INVALID_STATUS_TRANSITION' });
      const closed = await program(programId);
      expect(closed.status).toBe('CLOSED');
      expect(closed.open_blocking_breaks).toBe(0);

      await send({ type: 'PROGRAM_REINSTATED', programId, version: 6, payload: { amendmentRef: 'AMD-7' } });
      expect(await program(programId)).toMatchObject({ status: 'ACTIVE', status_reason: 'AMD-7', status_version: '6' });
    });
  });

  describe('messages ahead of the programme', () => {
    it('park, then resolve in order after the creating snapshot', async () => {
      const programId = unique('P');
      const first = await send(limit(programId, '500', 4));
      const second = await send(limit(programId, '700', 9));

      const parked = await db().query(
        `SELECT message_id, awaiting_kind::text AS kind, awaiting_ref FROM parked_message WHERE program_external_id = $1 ORDER BY "offset"`,
        [programId],
      );
      expect(parked.rows).toEqual([
        { message_id: first.messageId, kind: 'PROGRAM', awaiting_ref: programId },
        { message_id: second.messageId, kind: 'PRECEDING_MESSAGE', awaiting_ref: first.messageId },
      ]);
      expect((await statuses(first.messageId))[0]).toMatchObject({ status: 'PDNG', awaitingKind: 'PROGRAM' });

      await send(snapshot(programId));

      expect((await program(programId)).credit_limit).toBe('700.0000');
      expect(await inbox(first.messageId)).toMatchObject({ outcome: 'STALE' });
      expect(await inbox(second.messageId)).toMatchObject({ outcome: 'APPLIED' });
      expect((await statuses(second.messageId)).map((s) => s.status)).toEqual(['PDNG', 'ACCP']);
      const { rows } = await db().query(
        'SELECT count(*)::int AS n FROM parked_message WHERE program_external_id = $1 AND resolved_at IS NULL',
        [programId],
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe('redelivery', () => {
    it('answers a duplicate from the inbox without applying it twice', async () => {
      const programId = unique('P');
      await send(snapshot(programId));
      const message = raw(limit(programId, '1500', 6));
      await processor.process(message);
      await processor.process({ ...message, offset: offset++ });

      expect((await ledger((await program(programId)).id)).length).toBe(2);
      expect((await statuses(message.messageId)).map((s) => s.status)).toEqual(['ACCP']);
    });

    it('answers a duplicate of a parked message with PDNG again', async () => {
      const programId = unique('P');
      const message = raw(limit(programId, '500', 4));
      await processor.process(message);
      await processor.process({ ...message, offset: offset++ });
      expect((await statuses(message.messageId)).map((s) => s.status)).toEqual(['PDNG', 'PDNG']);
    });
  });

  describe('form errors', () => {
    it('sends an unreadable envelope to the DLQ without a decision', async () => {
      const before = publisher.sent.length;
      await send('{not json', 'P-whatever');
      const copy = publisher.sent.at(-1)!;
      expect(publisher.sent.length).toBe(before + 1);
      expect(copy).toMatchObject({ topic: 'capacity.dlq', value: '{not json' });
      expect(copy.headers['dlq-reason']).toMatch(/^UNREADABLE_ENVELOPE/);
    });

    it('rejects an invalid body finally, with a DLQ copy each time it arrives', async () => {
      const programId = unique('P');
      await send(snapshot(programId));
      const message = raw({ type: 'LIMIT_UPDATED', programId, version: 6, payload: { creditLimit: { amount: 1500, currency: 'EUR' } } });
      const before = publisher.sent.length;
      await processor.process(message);
      await processor.process({ ...message, offset: offset++ });

      expect(await inbox(message.messageId)).toEqual({ type: 'LIMIT_UPDATED', outcome: 'REJECTED', reason: 'INVALID_FORMAT' });
      expect((await statuses(message.messageId)).map((s) => s.status)).toEqual(['RJCT', 'RJCT']);
      expect(publisher.sent.slice(before).map((m) => m.headers['dlq-reason'])).toEqual(['INVALID_FORMAT', 'INVALID_FORMAT']);
    });

    it('rejects an unknown type with an empty type column', async () => {
      const message = await send({ type: 'SOMETHING_NEW', programId: unique('P') });
      expect(await inbox(message.messageId)).toEqual({ type: null, outcome: 'REJECTED', reason: 'UNKNOWN_MESSAGE_TYPE' });
    });

    it('rejects a known type in an unsupported schema version under its own reason', async () => {
      const before = publisher.sent.length;
      const message = await send({ ...limit(unique('P'), '500', 4), schemaVersion: 2 });
      expect(await inbox(message.messageId)).toEqual({
        type: 'LIMIT_UPDATED',
        outcome: 'REJECTED',
        reason: 'UNSUPPORTED_SCHEMA_VERSION',
      });
      expect(publisher.sent.slice(before).map((m) => m.headers['dlq-reason'])).toEqual(['UNSUPPORTED_SCHEMA_VERSION']);
    });

    it('records a message that fails on its data as rejected and copies it to the DLQ', async () => {
      const message = raw(limit(unique('P'), '500', 4));
      const before = publisher.sent.length;
      await processor.rejectPoison(message, new Error('numeric field overflow'));

      expect(await inbox(message.messageId)).toEqual({ type: 'LIMIT_UPDATED', outcome: 'REJECTED', reason: 'PROCESSING_FAILED' });
      expect((await statuses(message.messageId)).map((s) => s.status)).toEqual(['RJCT']);
      expect(publisher.sent.slice(before).map((m) => m.headers['dlq-reason'])).toEqual(['PROCESSING_FAILED']);
    });
  });
});