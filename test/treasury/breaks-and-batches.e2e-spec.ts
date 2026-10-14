import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { EventPublisher } from '../../src/outbox/event-publisher.js';
import { InboundProcessor } from '../../src/treasury/inbound.processor.js';
import { ReconciliationBatches } from '../../src/treasury/reconciliation-batches.js';
import { startApp } from '../support/app.js';
import { CapturingPublisher } from '../support/capturing-publisher.js';
import { closeDb, db, seedProgram, unique } from '../support/db.js';
import { token } from '../support/issuer.js';
import type { ProgramMessageInput } from '../support/support.types.js';
import { programMessage } from '../support/treasury-messages.js';

const ORIGINATION = { sub: 'svc-origination', azp: 'origination', scope: 'reservations:write programs:read:all' };

type Extra = Pick<ProgramMessageInput, 'version' | 'batchId' | 'brokerTime'>;

function message(type: string, programId: string | undefined, payload: Record<string, unknown>, extra: Extra = {}) {
  const raw = programMessage({ type, programId, payload, ...extra, asOf: new Date(Date.now() - 60_000).toISOString() });
  return { messageId: raw.messageId, raw };
}

interface SnapshotInput {
  limit?: string;
  limitVersion?: number;
  limitCurrency?: string;
  clientRef?: string;
  resolvedBreaks?: string[];
  batchId?: string;
}

describe('break resolution and reconciliation batches', () => {
  let app: NestFastifyApplication;
  let processor: InboundProcessor;
  let batches: ReconciliationBatches;
  let bearer: string;

  beforeAll(async () => {
    app = await startApp(undefined, (builder) =>
      builder.overrideProvider(EventPublisher).useValue(new CapturingPublisher()),
    );
    processor = app.get(InboundProcessor);
    batches = app.get(ReconciliationBatches);
    bearer = await token({ claims: ORIGINATION });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const send = async (type: string, programId: string | undefined, payload: Record<string, unknown>, extra?: Extra) => {
    const { messageId, raw } = message(type, programId, payload, extra);
    await processor.process(raw);
    return messageId;
  };

  const snapshot = (programId: string, input: SnapshotInput = {}) =>
    send(
      'PROGRAM_SNAPSHOT',
      programId,
      {
        currency: 'EUR',
        clientRef: input.clientRef ?? 'C-ACME',
        creditLimit: { amount: input.limit ?? '1000', currency: input.limitCurrency ?? 'EUR', version: input.limitVersion ?? 5 },
        externalUtilized: { amount: '0', currency: 'EUR', version: 1 },
        status: { value: 'ACTIVE', version: 1 },
        ...(input.resolvedBreaks ? { resolvedBreaks: input.resolvedBreaks } : {}),
      },
      { batchId: input.batchId },
    );

  const limit = (programId: string, amount: string, version: number, currency = 'EUR') =>
    send('LIMIT_UPDATED', programId, { creditLimit: { amount, currency } }, { version });

  const resolve = (programId: string, breakId: string) => send('BREAK_RESOLVED', programId, { breakId });

  const inbox = async (messageId: string) =>
    (await db().query('SELECT outcome::text AS outcome, reason FROM processed_message WHERE message_id = $1', [messageId]))
      .rows[0];

  const openBlocking = async (programId: string) =>
    (await db().query('SELECT open_blocking_breaks FROM program WHERE external_id = $1', [programId])).rows[0]
      ?.open_blocking_breaks;

  const breakOf = async (programId: string, reason: string) =>
    (
      await db().query(
        `SELECT b.id, b.blocking, b.resolved_at, b.resolution_message_id FROM program_break b
         LEFT JOIN program p ON p.id = b.program_id
         WHERE (p.external_id = $1 OR b.program_external_id = $1) AND b.reason = $2::"BreakReason"
         ORDER BY b.opened_at DESC LIMIT 1`,
        [programId, reason],
      )
    ).rows[0];

  const resolvedEvents = async (programId: string) =>
    (
      await db().query(
        `SELECT payload -> 'data' AS data FROM outbox_event WHERE partition_key = $1 AND type = 'PROGRAM_BREAK_RESOLVED' ORDER BY id`,
        [programId],
      )
    ).rows.map((row) => row.data);

  const batch = async (batchId: string) =>
    (await db().query('SELECT completed_at, alerted_at FROM reconciliation_batch WHERE batch_id = $1', [batchId])).rows[0];

  describe('BREAK_RESOLVED', () => {
    it('closes a version conflict only after the version moved on', async () => {
      const programId = unique('P');
      await snapshot(programId);
      await limit(programId, '900', 5);
      const conflict = await breakOf(programId, 'VERSION_CONFLICT');
      expect(await openBlocking(programId)).toBe(1);

      expect(await inbox(await resolve(programId, conflict.id))).toEqual({ outcome: 'REJECTED', reason: 'BREAK_NOT_RESOLVED' });
      expect(await openBlocking(programId)).toBe(1);

      await limit(programId, '900', 6);
      const resolution = await resolve(programId, conflict.id);
      expect(await inbox(resolution)).toEqual({ outcome: 'APPLIED', reason: null });
      expect(await openBlocking(programId)).toBe(0);
      expect(await breakOf(programId, 'VERSION_CONFLICT')).toMatchObject({ resolution_message_id: resolution });
      expect(await resolvedEvents(programId)).toMatchObject([
        { breakId: conflict.id, reason: 'VERSION_CONFLICT', blocking: true, resolutionMessageId: resolution },
      ]);

      expect(await inbox(await resolve(programId, conflict.id))).toEqual({ outcome: 'STALE', reason: null });
      expect(await openBlocking(programId)).toBe(0);
    });

    it('closes a currency mismatch once the same field arrives in the right currency, even as stale', async () => {
      const programId = unique('P');
      await snapshot(programId);
      await limit(programId, '900', 6, 'USD');
      const mismatch = await breakOf(programId, 'CURRENCY_MISMATCH');

      expect(await inbox(await resolve(programId, mismatch.id))).toMatchObject({ reason: 'BREAK_NOT_RESOLVED' });
      expect(await inbox(await limit(programId, '1000', 5))).toMatchObject({ outcome: 'STALE' });
      expect(await inbox(await resolve(programId, mismatch.id))).toMatchObject({ outcome: 'APPLIED' });
      expect(await openBlocking(programId)).toBe(0);
    });

    it('closes a non-blocking break on the confirmation alone', async () => {
      const programId = unique('P');
      await snapshot(programId);
      await send('PROGRAM_STATUS_CHANGED', programId, { status: 'CLOSED' }, { version: 2 });
      await send('PROGRAM_STATUS_CHANGED', programId, { status: 'ACTIVE' }, { version: 3 });
      const transition = await breakOf(programId, 'INVALID_STATUS_TRANSITION');
      expect(transition.blocking).toBe(false);

      expect(await inbox(await resolve(programId, transition.id))).toMatchObject({ outcome: 'APPLIED' });
    });

    it('does not find breaks of another programme or unknown ones', async () => {
      const programId = unique('P');
      const otherId = unique('P');
      await snapshot(programId);
      await snapshot(otherId);
      await limit(otherId, '900', 5);
      const foreign = await breakOf(otherId, 'VERSION_CONFLICT');

      expect(await inbox(await resolve(programId, foreign.id))).toEqual({ outcome: 'REJECTED', reason: 'UNKNOWN_BREAK' });
      expect(await inbox(await resolve(programId, randomUUID()))).toEqual({ outcome: 'REJECTED', reason: 'UNKNOWN_BREAK' });
      expect(await openBlocking(otherId)).toBe(1);
    });

    it('waits for the programme before closing a break of a contradictory creating snapshot', async () => {
      const programId = unique('P');
      await snapshot(programId, { limitCurrency: 'USD' });
      const orphan = await breakOf(programId, 'CURRENCY_MISMATCH');
      expect(orphan.blocking).toBe(false);

      const resolution = await resolve(programId, orphan.id);
      expect(await inbox(resolution)).toBeUndefined();

      await snapshot(programId);
      expect(await inbox(resolution)).toMatchObject({ outcome: 'APPLIED' });
      expect((await breakOf(programId, 'CURRENCY_MISMATCH')).resolved_at).not.toBeNull();
    });
  });

  describe('resolvedBreaks in a snapshot', () => {
    it('closes a client mismatch with the snapshot that confirms the owner', async () => {
      const programId = unique('P');
      await snapshot(programId);
      expect(await inbox(await snapshot(programId, { clientRef: 'C-OTHER' }))).toMatchObject({ reason: 'CLIENT_MISMATCH' });
      const mismatch = await breakOf(programId, 'CLIENT_MISMATCH');

      const confirming = await snapshot(programId, { resolvedBreaks: [mismatch.id] });
      expect(await inbox(confirming)).toMatchObject({ outcome: 'STALE' });
      expect(await breakOf(programId, 'CLIENT_MISMATCH')).toMatchObject({ resolution_message_id: confirming });
      expect(await openBlocking(programId)).toBe(0);
    });

    it('keeps a break open when the snapshot does not fix it, without failing the snapshot', async () => {
      const programId = unique('P');
      await snapshot(programId);
      await limit(programId, '900', 5);
      const conflict = await breakOf(programId, 'VERSION_CONFLICT');

      expect(await inbox(await snapshot(programId, { resolvedBreaks: [conflict.id] }))).toMatchObject({ outcome: 'STALE' });
      expect((await breakOf(programId, 'VERSION_CONFLICT')).resolved_at).toBeNull();

      expect(await inbox(await snapshot(programId, { limitVersion: 7, resolvedBreaks: [conflict.id] }))).toMatchObject({
        outcome: 'APPLIED',
      });
      expect((await breakOf(programId, 'VERSION_CONFLICT')).resolved_at).not.toBeNull();
      expect(await openBlocking(programId)).toBe(0);
    });

    it('closes nothing when the snapshot itself is rejected', async () => {
      const programId = unique('P');
      await snapshot(programId);
      await send('PROGRAM_STATUS_CHANGED', programId, { status: 'CLOSED' }, { version: 2 });
      await send('PROGRAM_STATUS_CHANGED', programId, { status: 'ACTIVE' }, { version: 3 });
      const transition = await breakOf(programId, 'INVALID_STATUS_TRANSITION');

      await snapshot(programId, { clientRef: 'C-OTHER', resolvedBreaks: [transition.id] });
      expect((await breakOf(programId, 'INVALID_STATUS_TRANSITION')).resolved_at).toBeNull();
    });
  });

  describe('invoice breaks', () => {
    const reserve = async (programId: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/reservations',
        headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': unique('key') },
        payload: { programId, invoiceId: unique('INV'), amount: '100.00', currency: 'EUR', dueDate: '2099-12-31' },
      });
      expect(res.statusCode).toBe(201);
      return res.json().invoiceId as string;
    };

    it('closes an unknown release once the reversal of that release is applied', async () => {
      const programId = await seedProgram();
      const invoiceId = await reserve(programId);
      await send('INVOICE_RELEASE_REVERSED', programId, { invoiceId, reversalId: unique('REV'), externalRef: 'A-7' });
      const unknown = await breakOf(programId, 'UNKNOWN_RELEASE');
      expect(await openBlocking(programId)).toBe(1);
      expect(await inbox(await resolve(programId, unknown.id))).toMatchObject({ reason: 'BREAK_NOT_RESOLVED' });

      await send('INVOICE_PAYMENT_ALLOCATED', programId, {
        invoiceId,
        allocationId: 'A-7',
        paymentId: 'PAY-7',
        payment: { amount: '40.00', currency: 'EUR' },
        settledAmount: { amount: '40.00', currency: 'EUR' },
      });
      await send('INVOICE_RELEASE_REVERSED', programId, { invoiceId, reversalId: unique('REV'), externalRef: 'A-7' });
      expect(await inbox(await resolve(programId, unknown.id))).toMatchObject({ outcome: 'APPLIED' });
      expect(await openBlocking(programId)).toBe(0);
    });

    it('closes a funding after cancellation once the cancellation is reversed', async () => {
      const programId = await seedProgram();
      const invoiceId = await reserve(programId);
      const cancellationId = unique('C');
      await send('INVOICE_FUNDING_CANCELLED', programId, { invoiceId, cancellationId, cancellationReason: 'PAYOUT_FAILED' });
      await send('INVOICE_FUNDED', programId, { invoiceId, fundingRef: unique('F') });
      const funded = await breakOf(programId, 'FUNDED_AFTER_CANCELLATION');
      expect(await inbox(await resolve(programId, funded.id))).toMatchObject({ reason: 'BREAK_NOT_RESOLVED' });

      await send('INVOICE_RELEASE_REVERSED', programId, { invoiceId, reversalId: unique('REV'), externalRef: cancellationId });
      expect(await inbox(await resolve(programId, funded.id))).toMatchObject({ outcome: 'APPLIED' });
      expect(await openBlocking(programId)).toBe(0);
    });
  });

  describe('reconciliation batches', () => {
    it('completes when the trailer arrives after all snapshots', async () => {
      const batchId = unique('B');
      const [first, second] = [unique('P'), unique('P')];
      await snapshot(first, { batchId });
      await snapshot(second, { batchId });
      await snapshot(second, { batchId });

      const trailer = await send('RECONCILIATION_BATCH_COMPLETED', undefined, { programCount: 2 }, { batchId });
      expect(await inbox(trailer)).toEqual({ outcome: 'APPLIED', reason: null });
      expect((await batch(batchId)).completed_at).not.toBeNull();
    });

    it('completes with the last snapshot when the trailer came first', async () => {
      const batchId = unique('B');
      await send('RECONCILIATION_BATCH_COMPLETED', undefined, { programCount: 2 }, { batchId });
      await snapshot(unique('P'), { batchId });
      expect((await batch(batchId)).completed_at).toBeNull();

      await snapshot(unique('P'), { batchId, clientRef: 'C-ACME', limitCurrency: 'USD' });
      expect((await batch(batchId)).completed_at).not.toBeNull();
    });

    it('answers a repeated trailer by its programme count', async () => {
      const batchId = unique('B');
      await send('RECONCILIATION_BATCH_COMPLETED', undefined, { programCount: 2 }, { batchId });
      expect(await inbox(await send('RECONCILIATION_BATCH_COMPLETED', undefined, { programCount: 2 }, { batchId }))).toEqual({
        outcome: 'STALE',
        reason: null,
      });
      expect(await inbox(await send('RECONCILIATION_BATCH_COMPLETED', undefined, { programCount: 3 }, { batchId }))).toEqual({
        outcome: 'REJECTED',
        reason: 'BATCH_CONFLICT',
      });
    });

    it('raises an alert past the deadline once and still completes late', async () => {
      const batchId = unique('B');
      const longAgo = new Date(Date.now() - 60 * 60 * 1000);
      await send('RECONCILIATION_BATCH_COMPLETED', undefined, { programCount: 2 }, { batchId, brokerTime: longAgo });
      await snapshot(unique('P'), { batchId });

      await batches.checkDeadlines();
      const alerted = (await batch(batchId)).alerted_at;
      expect(alerted).not.toBeNull();
      await batches.checkDeadlines();
      expect((await batch(batchId)).alerted_at).toEqual(alerted);

      await snapshot(unique('P'), { batchId });
      expect((await batch(batchId)).completed_at).not.toBeNull();
    });
  });
});