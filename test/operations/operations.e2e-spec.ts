import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { InternalReconciliation } from '../../src/operations/internal-reconciliation.js';
import { MaintenanceCleanup } from '../../src/operations/maintenance-cleanup.js';
import { OperationalMonitors } from '../../src/operations/monitors.js';
import { EventPublisher } from '../../src/outbox/event-publisher.js';
import { InboundProcessor } from '../../src/treasury/inbound.processor.js';
import { startApp } from '../support/app.js';
import { CapturingPublisher } from '../support/capturing-publisher.js';
import { closeDb, db, ownerDb, seedProgram, unique } from '../support/db.js';
import { token } from '../support/issuer.js';
import { programMessage } from '../support/treasury-messages.js';

const treasury = (type: string, programId: string, payload: Record<string, unknown>) => programMessage({ type, programId, payload });

const snapshot = (limit = '1000') => ({
  currency: 'EUR',
  clientRef: 'C-OPS',
  creditLimit: { amount: limit, currency: 'EUR', version: 1 },
  externalUtilized: { amount: '0', currency: 'EUR', version: 1 },
  status: { value: 'ACTIVE', version: 1 },
});

describe('operational jobs', () => {
  let app: NestFastifyApplication;
  let processor: InboundProcessor;
  let monitors: OperationalMonitors;
  let reconciliation: InternalReconciliation;
  let cleanup: MaintenanceCleanup;
  let origination: string;

  beforeAll(async () => {
    app = await startApp(undefined, (builder) => builder.overrideProvider(EventPublisher).useValue(new CapturingPublisher()));
    processor = app.get(InboundProcessor);
    monitors = app.get(OperationalMonitors);
    reconciliation = app.get(InternalReconciliation);
    cleanup = app.get(MaintenanceCleanup);
    origination = await token({ claims: { sub: 'svc-origination', scope: 'reservations:write programs:read:all' } });
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  const send = (type: string, programId: string, payload: Record<string, unknown>) => processor.process(treasury(type, programId, payload));

  async function program() {
    const programId = unique('P');
    await send('PROGRAM_SNAPSHOT', programId, snapshot());
    return programId;
  }

  async function reserve(programId: string, idempotencyKey = unique('key')) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/reservations',
      headers: { authorization: `Bearer ${origination}`, 'idempotency-key': idempotencyKey },
      payload: { programId, invoiceId: unique('INV'), amount: '100.00', currency: 'EUR', dueDate: '2099-12-31' },
    });
    expect(res.statusCode).toBe(201);
    return { id: res.json().id as string, invoiceId: res.json().invoiceId as string };
  }

  describe('monitors', () => {
    it('tells an unfunded overdue reservation from a funded one', async () => {
      const programId = await program();
      const leak = await reserve(programId);
      const arrears = await reserve(programId);
      await send('INVOICE_FUNDED', programId, { invoiceId: arrears.invoiceId, fundingRef: unique('F') });
      await ownerDb().query(`UPDATE reservation SET due_date = '2020-01-31' WHERE id = ANY($1::uuid[])`, [[leak.id, arrears.id]]);

      const { overdue } = await monitors.check();
      expect(overdue).toEqual(
        expect.arrayContaining([
          { reservationId: leak.id, programId, invoiceId: leak.invoiceId, dueDate: '2020-01-31', funded: false },
          { reservationId: arrears.id, programId, invoiceId: arrears.invoiceId, dueDate: '2020-01-31', funded: true },
        ]),
      );
    });

    it('reports parked messages that waited too long', async () => {
      const programId = await program();
      const { invoiceId } = await reserve(programId);
      const message = treasury('INVOICE_PAYMENT_ALLOCATED', programId, {
        invoiceId,
        allocationId: 'A-1',
        paymentId: 'PAY-1',
        payment: { amount: '10.00', currency: 'NZD' },
        settledAmount: { amount: '5.00', currency: 'EUR' },
        fxRateId: unique('R'),
      });
      await processor.process(message);
      const messageId = JSON.parse(message.value!).messageId as string;
      expect((await monitors.check()).agedParked.map((item) => item.messageId)).not.toContain(messageId);

      await ownerDb().query(`UPDATE parked_message SET parked_at = now() - interval '1 hour' WHERE message_id = $1`, [messageId]);
      expect((await monitors.check()).agedParked).toEqual(expect.arrayContaining([expect.objectContaining({ messageId, programId, awaitingKind: 'FX_RATE' })]));
    });

    it('reports programmes treasury has not confirmed for too long', async () => {
      const fresh = await program();
      const silent = await program();
      await ownerDb().query(`UPDATE program SET treasury_synced_at = now() - interval '2 days' WHERE external_id = $1`, [silent]);

      const stale = (await monitors.check()).staleTreasury.map((item) => item.programId);
      expect(stale).toContain(silent);
      expect(stale).not.toContain(fresh);
    });
  });

  describe('internal reconciliation', () => {
    const subjects = async (check: string) => (await reconciliation.run()).mismatches.filter((item) => item.check === check).map((item) => item.subject);

    it('finds nothing wrong with a consistent programme', async () => {
      const programId = await program();
      const { invoiceId } = await reserve(programId);
      await send('INVOICE_PAYMENT_ALLOCATED', programId, {
        invoiceId,
        allocationId: 'A-1',
        paymentId: 'PAY-1',
        payment: { amount: '40.00', currency: 'EUR' },
        settledAmount: { amount: '40.00', currency: 'EUR' },
      });
      const report = await reconciliation.run();
      expect(report.mismatches.filter((item) => item.subject === programId)).toEqual([]);
    });

    it('catches totals edited behind the application', async () => {
      const programId = await program();
      await reserve(programId);
      await ownerDb().query(`UPDATE program SET reserved = reserved + 1, open_blocking_breaks = 2 WHERE external_id = $1`, [programId]);

      const report = await reconciliation.run();
      const mine = report.mismatches.filter((item) => item.subject === programId);
      expect(mine).toEqual(
        expect.arrayContaining([
          { check: 'PROGRAM_RESERVED', subject: programId, expected: '100.0000', actual: '101.0000' },
          expect.objectContaining({ check: 'PROGRAM_LEDGER', subject: programId }),
          { check: 'OPEN_BLOCKING_BREAKS', subject: programId, expected: '0', actual: '2' },
        ]),
      );
      expect(report.ok).toBe(false);
    });

    it('catches a broken ledger chain', async () => {
      const programId = await program();
      await reserve(programId);
      const { rows } = await ownerDb().query(
        `UPDATE capacity_ledger SET reserved_after = reserved_after + 5
         WHERE id = (SELECT max(l.id) FROM capacity_ledger l JOIN program p ON p.id = l.program_id WHERE p.external_id = $1)
         RETURNING id::text`,
        [programId],
      );
      expect(await subjects('LEDGER_CHAIN')).toContain(rows[0].id);
    });

    it('checks changed reservations daily and every reservation on the weekly full sweep', async () => {
      const programId = await program();
      const { id } = await reserve(programId);
      await ownerDb().query(`UPDATE reservation SET updated_at = now() - interval '1 day' WHERE id = $1`, [id]);
      await ownerDb().query(
        `INSERT INTO reconciliation_checkpoint ("check", watermark, updated_at)
         VALUES ('RESERVATIONS', $1, now()), ('FULL_SWEEP', $1, now())
         ON CONFLICT ("check") DO UPDATE SET watermark = EXCLUDED.watermark`,
        [new Date().toISOString()],
      );
      await ownerDb().query(`UPDATE reservation SET funding_ref = $2, funded_at = now() WHERE id = $1`, [id, unique('F')]);

      expect(await subjects('RESERVATION_FUNDING')).not.toContain(id);

      await ownerDb().query(`UPDATE reconciliation_checkpoint SET watermark = $1 WHERE "check" = 'FULL_SWEEP'`, [
        new Date(Date.now() - 8 * 86_400_000).toISOString(),
      ]);
      expect(await subjects('RESERVATION_FUNDING')).toContain(id);
    });

    it('is available to auditors on demand', async () => {
      const auditor = await token({ claims: { sub: 'auditor', scope: 'programs:read:all audit:read' } });
      const res = await app.inject({ method: 'GET', url: '/v1/audit/reconciliation', headers: { authorization: `Bearer ${auditor}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ checkedAt: expect.any(String), ok: expect.any(Boolean), mismatches: expect.any(Array) });
    });
  });

  describe('maintenance cleanup', () => {
    it('removes published outbox events past retention and expired idempotency records', async () => {
      const programId = await seedProgram();
      const key = unique('key');
      const { id } = await reserve(programId, key);
      await db().query(`UPDATE outbox_event SET published_at = now() - interval '2 days' WHERE payload -> 'data' ->> 'reservationId' = $1`, [id]);
      await ownerDb().query(
        `UPDATE idempotency_record SET created_at = now() - interval '8 days', expires_at = now() - interval '1 minute'
         WHERE key = $1`,
        [key],
      );

      const result = await cleanup.run();
      expect(result.outboxEvents).toBeGreaterThanOrEqual(1);
      expect(result.idempotencyRecords).toBeGreaterThanOrEqual(1);
      expect((await db().query(`SELECT 1 FROM outbox_event WHERE payload -> 'data' ->> 'reservationId' = $1`, [id])).rowCount).toBe(0);
      expect((await db().query('SELECT 1 FROM idempotency_record WHERE key = $1', [key])).rowCount).toBe(0);
    });
  });
});
