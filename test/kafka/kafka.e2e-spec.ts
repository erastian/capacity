import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  Consumer,
  MessagesStreamModes,
  Producer,
  ProduceAcks,
  stringDeserializers,
  stringSerializers,
} from '@platformatic/kafka';
import { randomUUID } from 'node:crypto';
import { closeDb, db, seedProgram, unique } from '../support/db.js';
import { token } from '../support/issuer.js';
import { KAFKA_USERS, startKafka } from '../support/kafka.js';
import type { ReceivedMessage as Received, StartedKafka } from '../support/support.types.js';

const ORIGINATION = { sub: 'svc-origination', azp: 'origination', scope: 'reservations:write programs:read:all' };

describe('with Kafka', () => {
  let kafka: StartedKafka;
  let startApp: typeof import('../support/app.js').startApp;
  let OutboxRelay: typeof import('../../src/outbox/outbox.relay.js').OutboxRelay;
  const apps: NestFastifyApplication[] = [];
  let bearer: string;

  beforeAll(async () => {
    kafka = await startKafka();
    Object.assign(process.env, {
      KAFKA_BROKERS: kafka.brokers,
      KAFKA_SASL_USERNAME: KAFKA_USERS.capacity.username,
      KAFKA_SASL_PASSWORD: KAFKA_USERS.capacity.password,
      OUTBOX_RELAY_ENABLED: 'true',
      OUTBOX_POLL_INTERVAL_MS: '50',
      OUTBOX_LEADER_RETRY_MS: '200',
      TREASURY_CONSUMER_ENABLED: 'true',
      TREASURY_CONSUMER_GROUP: `capacity-test-${randomUUID()}`,
      PUBLISH_ACCEPTED_STATUS: 'true',
    });
    ({ startApp } = await import('../support/app.js'));
    ({ OutboxRelay } = await import('../../src/outbox/outbox.relay.js'));
    bearer = await token({ claims: ORIGINATION });
    apps.push(await startApp());
  }, 180_000);

  afterAll(async () => {
    for (const app of apps) await app.close();
    await closeDb();
    await kafka?.stop();
  });

  async function collect(topic: string, predicate: (m: Received) => boolean, count: number): Promise<Received[]> {
    const consumer = new Consumer({
      clientId: 'kafka-e2e',
      groupId: `consumer-test-${randomUUID()}`,
      bootstrapBrokers: [kafka.brokers],
      sasl: { mechanism: 'PLAIN', ...KAFKA_USERS.consumer },
      deserializers: stringDeserializers,
      maxWaitTime: 200,
    });
    const stream = await consumer.consume({ topics: [topic], mode: MessagesStreamModes.EARLIEST });
    const received: Received[] = [];
    const deadline = setTimeout(() => void stream.close(), 30_000);
    try {
      for await (const message of stream) {
        const item: Received = {
          key: message.key ?? null,
          value: message.value,
          headers: Object.fromEntries(message.headers),
        };
        if (predicate(item)) received.push(item);
        if (received.length >= count) break;
      }
    } finally {
      clearTimeout(deadline);
      await stream.close();
      await consumer.close();
    }
    return received;
  }

  const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 20_000) => {
    const started = Date.now();
    while (!(await check())) {
      if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const reserve = (app: NestFastifyApplication, programId: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/reservations',
      headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': unique('key') },
      payload: { programId, invoiceId: unique('INV'), amount: '10.00', currency: 'EUR', dueDate: '2099-12-31' },
    });

  const json = (m: Received) => JSON.parse(m.value);

  describe('outbox relay', () => {
    it('publishes a reservation and marks the outbox row', async () => {
      const programId = await seedProgram();
      const res = await reserve(apps[0], programId);
      expect(res.statusCode).toBe(201);
      const reservationId = res.json().id;

      const [message] = await collect('capacity.reservation-events', (m) => json(m).data?.id === reservationId, 1);
      const value = json(message);
      expect(message.key).toBe(programId);
      expect(value).toMatchObject({ type: 'RESERVATION_CREATED', schemaVersion: 1 });
      expect(message.headers).toMatchObject({ 'event-type': 'RESERVATION_CREATED', 'event-id': value.eventId });

      await waitFor(async () => {
        const { rows } = await db().query('SELECT published_at FROM outbox_event WHERE event_id = $1', [value.eventId]);
        return rows.length === 1 && rows[0].published_at !== null;
      });
    });

    it('keeps the order of events within a program', async () => {
      const programId = await seedProgram();
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) ids.push((await reserve(apps[0], programId)).json().id);

      const messages = await collect('capacity.reservation-events', (m) => m.key === programId, 10);
      expect(messages.map((m) => json(m).data.id)).toEqual(ids);
    });

    it('elects a single leader and fails over when it stops', async () => {
      apps.push(await startApp());
      const relays = () => apps.map((app) => app.get(OutboxRelay));

      await waitFor(() => relays().some((relay) => relay.isLeader));
      await new Promise((r) => setTimeout(r, 600));
      expect(relays().filter((relay) => relay.isLeader)).toHaveLength(1);

      const [leader] = apps.splice(relays().findIndex((relay) => relay.isLeader), 1);
      await leader.close();

      await waitFor(() => apps[0].get(OutboxRelay).isLeader);
      const programId = await seedProgram();
      const id = (await reserve(apps[0], programId)).json().id;
      const [message] = await collect('capacity.reservation-events', (m) => json(m).data?.id === id, 1);
      expect(message.key).toBe(programId);
    });
  });

  describe('treasury consumer', () => {
    let producer: Producer<string, string, string, string>;

    beforeAll(() => {
      producer = new Producer({
        clientId: 'treasury-simulator',
        bootstrapBrokers: [kafka.brokers],
        sasl: { mechanism: 'PLAIN', ...KAFKA_USERS.treasury },
        serializers: stringSerializers,
        idempotent: true,
        acks: ProduceAcks.ALL,
      });
    });

    afterAll(async () => {
      await producer.close();
    });

    const sendTreasury = (key: string, value: unknown) =>
      producer.send({
        messages: [
          {
            topic: 'treasury.program-capacity',
            key,
            value: typeof value === 'string' ? value : JSON.stringify(value),
          },
        ],
      });

    it('creates a programme from a snapshot and reports ACCP', async () => {
      const programId = unique('P');
      const messageId = unique('m');
      const asOf = new Date(Date.now() - 1000).toISOString();
      await sendTreasury(programId, {
        messageId,
        type: 'PROGRAM_SNAPSHOT',
        schemaVersion: 1,
        programId,
        asOf,
        payload: {
          currency: 'EUR',
          clientRef: 'C-ACME',
          creditLimit: { amount: '5000', currency: 'EUR', version: 1 },
          externalUtilized: { amount: '0', currency: 'EUR', version: 1 },
          status: { value: 'ACTIVE', version: 1 },
        },
      });

      await waitFor(async () => {
        const { rows } = await db().query('SELECT credit_limit FROM program WHERE external_id = $1', [programId]);
        return rows[0]?.credit_limit === '5000.0000';
      });

      const { rows } = await db().query(
        'SELECT kafka_timestamp, as_of FROM processed_message WHERE message_id = $1',
        [messageId],
      );
      expect(rows[0].kafka_timestamp.getTime()).toBeGreaterThanOrEqual(new Date(asOf).getTime());

      const [status] = await collect('capacity.message-status', (m) => json(m).data?.messageId === messageId, 1);
      expect(status.key).toBe(programId);
      expect(json(status).data).toMatchObject({ status: 'ACCP', messageId });
    });

    it('stores an FX quote from its own topic', async () => {
      const rateId = unique('R');
      await producer.send({
        messages: [
          {
            topic: 'treasury.fx-rates',
            key: 'NOK:EUR:VALUATION',
            value: JSON.stringify({
              messageId: unique('m'),
              type: 'FX_RATE_PUBLISHED',
              schemaVersion: 1,
              version: '1',
              asOf: new Date().toISOString(),
              payload: { rateId, from: 'NOK', to: 'EUR', rateType: 'VALUATION', status: 'ACTIVE', rate: '0.0861' },
            }),
          },
        ],
      });

      await waitFor(async () => {
        const { rows } = await db().query('SELECT rate FROM fx_rate WHERE external_id = $1', [rateId]);
        return rows[0]?.rate === '0.086100000000000000';
      });
    });

    it('quarantines an unreadable message in the DLQ and moves on', async () => {
      const key = unique('P');
      await sendTreasury(key, '{definitely not json');
      const [copy] = await collect('capacity.dlq', (m) => m.key === key, 1);
      expect(copy.value).toBe('{definitely not json');
      expect(copy.headers['dlq-reason']).toMatch(/^UNREADABLE_ENVELOPE/);
      expect(copy.headers['source-topic']).toBe('treasury.program-capacity');
    });
  });
});