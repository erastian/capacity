import pg from 'pg';
import { inject } from 'vitest';

const CHECK = '23514';
const UNIQUE = '23505';
const DENIED = '42501';

const PROGRAM = '00000000-0000-0000-0000-000000000001';
const RESERVATION = '00000000-0000-0000-0000-0000000000a1';
const RELEASE = '00000000-0000-0000-0000-0000000000b1';

const FIXTURES = `
  INSERT INTO processed_message (message_id, type, outcome, as_of, kafka_timestamp, topic, partition, "offset") VALUES
    ('m1', 'PROGRAM_SNAPSHOT', 'APPLIED', now(), now(), 't', 0, 1),
    ('m2', 'INVOICE_PAYMENT_ALLOCATED', 'APPLIED', now(), now(), 't', 0, 2),
    ('m3', 'INVOICE_RELEASE_REVERSED', 'APPLIED', now(), now(), 't', 0, 3),
    ('m4', 'INVOICE_FUNDED', 'APPLIED', now(), now(), 't', 0, 4),
    ('m5', 'INVOICE_FUNDED', 'APPLIED', now(), now(), 't', 0, 5),
    ('m6', 'FX_RATE_PUBLISHED', 'APPLIED', now(), now(), 't', 0, 6);
  INSERT INTO program (id, external_id, client_ref, currency, credit_limit, updated_at)
    VALUES ('${PROGRAM}', 'P1', 'C1', 'EUR', 1000, now());
  INSERT INTO fx_rate (external_id, from_currency, to_currency, rate_type, version, rate, status, as_of, kafka_timestamp, message_id)
    VALUES ('R1', 'USD', 'EUR', 'VALUATION', 1, 0.000012103412345678, 'ACTIVE', now(), now(), 'm6');
  INSERT INTO reservation (id, program_id, invoice_id, original_amount, original_currency, amount, due_date, created_by, correlation_id, updated_at)
    VALUES ('${RESERVATION}', '${PROGRAM}', 'INV1', 100, 'EUR', 100, current_date + 30, 'origination', 'c1', now());
`;

type Case = [name: string, sql: string, expected: 'ok' | string];

const APP_CASES: Case[] = [
  ['ok: ledger RESERVE', `INSERT INTO capacity_ledger (program_id, type, reserved_delta, credit_limit_after, external_utilized_after, reserved_after, reservation_id) VALUES ('${PROGRAM}', 'RESERVE', 100, 1000, 0, 100, '${RESERVATION}')`, 'ok'],
  ['ok: release REPAYMENT', `INSERT INTO reservation_release (id, reservation_id, reason, external_ref, payment_amount, payment_currency, original_amount, amount, message_id) VALUES ('${RELEASE}', '${RESERVATION}', 'REPAYMENT', 'A1', 40, 'EUR', 40, 40, 'm2')`, 'ok'],
  ['ok: release REVERSAL', `INSERT INTO reservation_release (reservation_id, reason, external_ref, original_amount, amount, reverses_release_id, message_id) VALUES ('${RESERVATION}', 'REVERSAL', 'RV1', 40, 40, '${RELEASE}', 'm3')`, 'ok'],
  ['ok: reservation PARTIALLY_RELEASED', `UPDATE reservation SET status = 'PARTIALLY_RELEASED', released_original_amount = 40, released_amount = 40, updated_at = now() WHERE id = '${RESERVATION}'`, 'ok'],
  ['ok: first active funding', `INSERT INTO reservation_funding (reservation_id, funding_ref, funded_at, message_id) VALUES ('${RESERVATION}', 'F1', now(), 'm4')`, 'ok'],
  ['ok: app updates reserved', `UPDATE program SET reserved = 100, updated_at = now() WHERE id = '${PROGRAM}'`, 'ok'],
  ['ok: app marks outbox published', `WITH e AS (INSERT INTO outbox_event (type, program_id, partition_key, payload) VALUES ('RESERVATION_CREATED', '${PROGRAM}', 'P1', '{}') RETURNING id) UPDATE outbox_event SET published_at = now() WHERE id IN (SELECT id FROM e)`, 'ok'],

  ['program currency lowercase', `INSERT INTO program (external_id, client_ref, currency, credit_limit, updated_at) VALUES ('P2', 'C', 'eur', 1, now())`, CHECK],
  ['program negative limit', `INSERT INTO program (external_id, client_ref, currency, credit_limit, updated_at) VALUES ('P3', 'C', 'EUR', -1, now())`, CHECK],
  ['reservation ACTIVE with released', `UPDATE reservation SET status = 'ACTIVE', updated_at = now() WHERE id = '${RESERVATION}'`, CHECK],
  ['reservation RELEASED with debt', `UPDATE reservation SET status = 'RELEASED', updated_at = now() WHERE id = '${RESERVATION}'`, CHECK],
  ['reservation released over amount', `UPDATE reservation SET released_original_amount = 101, updated_at = now() WHERE id = '${RESERVATION}'`, CHECK],
  ['reservation without rate but amounts differ', `INSERT INTO reservation (program_id, invoice_id, original_amount, original_currency, amount, due_date, created_by, correlation_id, updated_at) VALUES ('${PROGRAM}', 'INV2', 100, 'USD', 90, current_date, 'o', 'c', now())`, CHECK],
  ['reservation funded_at without funding_ref', `UPDATE reservation SET funded_at = now(), updated_at = now() WHERE id = '${RESERVATION}'`, CHECK],
  ['fx ACTIVE without rate', `INSERT INTO fx_rate (external_id, from_currency, to_currency, rate_type, version, rate, status, as_of, kafka_timestamp, message_id) VALUES ('R2', 'USD', 'EUR', 'VALUATION', 2, NULL, 'ACTIVE', now(), now(), 'm1')`, CHECK],
  ['fx SUSPENDED with rate', `INSERT INTO fx_rate (external_id, from_currency, to_currency, rate_type, version, rate, status, as_of, kafka_timestamp, message_id) VALUES ('R3', 'USD', 'EUR', 'VALUATION', 3, 1.1, 'SUSPENDED', now(), now(), 'm1')`, CHECK],
  ['fx same currency pair', `INSERT INTO fx_rate (external_id, from_currency, to_currency, rate_type, version, rate, status, as_of, kafka_timestamp, message_id) VALUES ('R4', 'EUR', 'EUR', 'VALUATION', 1, 1, 'ACTIVE', now(), now(), 'm1')`, CHECK],
  ['inbox REJECTED without reason', `INSERT INTO processed_message (message_id, type, outcome, as_of, kafka_timestamp, topic, partition, "offset") VALUES ('x1', 'LIMIT_UPDATED', 'REJECTED', now(), now(), 't', 0, 9)`, CHECK],
  ['inbox unknown type without reason', `INSERT INTO processed_message (message_id, type, outcome, as_of, kafka_timestamp, topic, partition, "offset") VALUES ('x2', NULL, 'APPLIED', now(), now(), 't', 0, 9)`, CHECK],
  ['inbox unknown type with wrong reason', `INSERT INTO processed_message (message_id, type, outcome, reason, as_of, kafka_timestamp, topic, partition, "offset") VALUES ('x3', NULL, 'REJECTED', 'INVALID_FORMAT', now(), now(), 't', 0, 9)`, CHECK],
  ['release REPAYMENT without payment', `INSERT INTO reservation_release (reservation_id, reason, external_ref, original_amount, amount, message_id) VALUES ('${RESERVATION}', 'REPAYMENT', 'A9', 1, 1, 'm5')`, CHECK],
  ['release CANCELLATION with payment', `INSERT INTO reservation_release (reservation_id, reason, external_ref, payment_amount, payment_currency, original_amount, amount, message_id) VALUES ('${RESERVATION}', 'CANCELLATION', 'C9', 1, 'EUR', 1, 1, 'm5')`, CHECK],
  ['release REVERSAL without target', `INSERT INTO reservation_release (reservation_id, reason, external_ref, original_amount, amount, message_id) VALUES ('${RESERVATION}', 'REVERSAL', 'RV9', 1, 1, 'm5')`, CHECK],
  ['release write_off_reason on REPAYMENT', `INSERT INTO reservation_release (reservation_id, reason, external_ref, payment_amount, payment_currency, write_off_reason, original_amount, amount, message_id) VALUES ('${RESERVATION}', 'REPAYMENT', 'A8', 1, 'EUR', 'CREDIT_LOSS', 1, 1, 'm5')`, CHECK],
  ['ledger RESERVE with message_id', `INSERT INTO capacity_ledger (program_id, type, reserved_delta, credit_limit_after, external_utilized_after, reserved_after, reservation_id, message_id) VALUES ('${PROGRAM}', 'RESERVE', 1, 1000, 0, 1, '${RESERVATION}', 'm1')`, CHECK],
  ['ledger RELEASE with positive delta', `INSERT INTO capacity_ledger (program_id, type, reserved_delta, credit_limit_after, external_utilized_after, reserved_after, reservation_id, release_id, message_id) VALUES ('${PROGRAM}', 'RELEASE', 5, 1000, 0, 1, '${RESERVATION}', '${RELEASE}', 'm2')`, CHECK],
  ['ledger SNAPSHOT with zero deltas', `INSERT INTO capacity_ledger (program_id, type, credit_limit_after, external_utilized_after, reserved_after, message_id) VALUES ('${PROGRAM}', 'TREASURY_SNAPSHOT', 1000, 0, 0, 'm1')`, CHECK],
  ['break without program reference', `INSERT INTO program_break (reason, blocking, message_id, details) VALUES ('VERSION_CONFLICT', false, 'm1', '{}')`, CHECK],
  ['blocking break without program', `INSERT INTO program_break (program_external_id, reason, blocking, message_id, details) VALUES ('PX', 'CLIENT_MISMATCH', true, 'm1', '{}')`, CHECK],
  ['idempotency status 100', `INSERT INTO idempotency_record (client_id, key, request_hash, response_status, response_body, expires_at) VALUES ('o', 'k', 'h', 100, '{}', now() + interval '1 day')`, CHECK],

  ['second active funding on a reservation', `INSERT INTO reservation_funding (reservation_id, funding_ref, funded_at, message_id) VALUES ('${RESERVATION}', 'F2', now(), 'm5')`, UNIQUE],

  ['app updates program.currency', `UPDATE program SET currency = 'USD'`, DENIED],
  ['app updates program.client_ref', `UPDATE program SET client_ref = 'C2'`, DENIED],
  ['app updates reservation.original_amount', `UPDATE reservation SET original_amount = 1`, DENIED],
  ['app updates reservation.fx_rate_id', `UPDATE reservation SET fx_rate_id = NULL`, DENIED],
  ['app updates ledger', `UPDATE capacity_ledger SET reserved_after = 0`, DENIED],
  ['app deletes ledger', `DELETE FROM capacity_ledger`, DENIED],
  ['app updates inbox', `UPDATE processed_message SET outcome = 'REJECTED'`, DENIED],
  ['app deletes releases', `DELETE FROM reservation_release`, DENIED],
  ['app updates fx rates', `UPDATE fx_rate SET rate = 2`, DENIED],
  ['app deletes outbox', `DELETE FROM outbox_event`, DENIED],
  ['app updates idempotency', `UPDATE idempotency_record SET response_status = 200`, DENIED],
  ['app creates a table', `CREATE TABLE public.evil (id int)`, DENIED],
  ['app creates a temp table', `CREATE TEMP TABLE evil (id int)`, DENIED],
  ['app reads prisma migrations', `SELECT count(*) FROM _prisma_migrations`, DENIED],
];

const MAINTENANCE_CASES: Case[] = [
  ['ok: deletes published outbox', `DELETE FROM outbox_event WHERE published_at IS NOT NULL`, 'ok'],
  ['ok: deletes expired idempotency', `DELETE FROM idempotency_record WHERE expires_at < now()`, 'ok'],
  ['maintenance deletes ledger', `DELETE FROM capacity_ledger`, DENIED],
  ['maintenance deletes inbox', `DELETE FROM processed_message`, DENIED],
  ['maintenance reads programs', `SELECT count(*) FROM program`, DENIED],
  ['maintenance inserts outbox', `INSERT INTO outbox_event (type, partition_key, payload) VALUES ('RESERVATION_CREATED', 'x', '{}')`, DENIED],
  ['maintenance updates outbox', `UPDATE outbox_event SET published_at = now()`, DENIED],
];

async function outcome(client: pg.Client, sql: string): Promise<string> {
  await client.query('SAVEPOINT guard');
  try {
    await client.query(sql);
    await client.query('RELEASE SAVEPOINT guard');
    return 'ok';
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT guard');
    return (error as { code?: string }).code ?? 'unknown';
  }
}

function describeRole(
  role: 'app' | 'maintenance',
  cases: Case[],
  fixtures?: string,
) {
  describe(`schema guards for ${role}`, () => {
    const client = new pg.Client({ connectionString: inject('databaseUrls')[role] });

    beforeAll(async () => {
      await client.connect();
      await client.query('BEGIN');
      if (fixtures) await client.query(fixtures);
    });

    afterAll(async () => {
      await client.query('ROLLBACK');
      await client.end();
    });

    it.each(cases)('%s', async (_, sql, expected) => {
      expect(await outcome(client, sql)).toBe(expected);
    });
  });
}

describeRole('app', APP_CASES, FIXTURES);
describeRole('maintenance', MAINTENANCE_CASES);