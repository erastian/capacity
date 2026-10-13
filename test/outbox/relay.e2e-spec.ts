import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Consumer, MessagesStreamModes, stringDeserializers } from '@platformatic/kafka';
import { randomUUID } from 'node:crypto';
import { closeDb, db, seedProgram, unique } from '../support/db.js';
import { token } from '../support/issuer.js';
import { KAFKA_USERS, type StartedKafka, startKafka } from '../support/kafka.js';

const ORIGINATION = { sub: 'svc-origination', azp: 'origination', scope: 'reservations:write programs:read:all' };
const TOPIC = 'capacity.reservation-events';

interface Received {
  key: string;
  value: { eventId: string; type: string; data: { id: string; invoiceId: string } };
  headers: Record<string, string>;
}

describe('outbox relay', () => {
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
    });
    ({ startApp } = await import('../support/app.js'));
    ({ OutboxRelay } = await import('../../src/outbox/outbox.relay.js'));
    bearer = await token({ claims: ORIGINATION });
  }, 180_000);

  afterAll(async () => {
    for (const app of apps) await app.close();
    await closeDb();
    await kafka?.stop();
  });

  const launch = async () => {
    const app = await startApp();
    apps.push(app);
    return app;
  };

  const reserve = (app: NestFastifyApplication, programId: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/reservations',
      headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': unique('key') },
      payload: {
        programId,
        invoiceId: unique('INV'),
        amount: '10.00',
        currency: 'EUR',
        dueDate: '2099-12-31',
      },
    });

  async function collect(predicate: (m: Received) => boolean, count: number): Promise<Received[]> {
    const consumer = new Consumer({
      clientId: 'relay-test',
      groupId: `consumer-test-${randomUUID()}`,
      bootstrapBrokers: [kafka.brokers],
      sasl: { mechanism: 'PLAIN', ...KAFKA_USERS.consumer },
      deserializers: stringDeserializers,
      maxWaitTime: 200,
    });
    const stream = await consumer.consume({ topics: [TOPIC], mode: MessagesStreamModes.EARLIEST });
    const received: Received[] = [];
    const deadline = setTimeout(() => void stream.close(), 20_000);
    try {
      for await (const message of stream) {
        const item: Received = {
          key: message.key,
          value: JSON.parse(message.value),
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

  const waitFor = async (check: () => boolean | Promise<boolean>, timeoutMs = 10_000) => {
    const started = Date.now();
    while (!(await check())) {
      if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it('publishes a reservation to Kafka and marks the outbox row', async () => {
    const app = await launch();
    const programId = await seedProgram();
    const res = await reserve(app, programId);
    expect(res.statusCode).toBe(201);
    const reservationId = res.json().id;

    const [message] = await collect((m) => m.value.data?.id === reservationId, 1);
    expect(message.key).toBe(programId);
    expect(message.value).toMatchObject({ type: 'RESERVATION_CREATED', schemaVersion: 1 });
    expect(message.headers).toMatchObject({
      'event-type': 'RESERVATION_CREATED',
      'event-id': message.value.eventId,
    });

    await waitFor(async () => {
      const { rows } = await db().query(
        'SELECT published_at FROM outbox_event WHERE event_id = $1',
        [message.value.eventId],
      );
      return rows[0]?.published_at !== null && rows.length === 1;
    });
  });

  it('keeps the order of events within a program', async () => {
    const app = apps[0];
    const programId = await seedProgram();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await reserve(app, programId)).json().id);

    const messages = await collect((m) => m.key === programId, 10);
    expect(messages.map((m) => m.value.data.id)).toEqual(ids);
  });

  it('elects a single leader and fails over when it stops', async () => {
    await launch();
    const relays = () => apps.map((app) => app.get(OutboxRelay));

    await waitFor(() => relays().some((relay) => relay.isLeader));
    await new Promise((r) => setTimeout(r, 600));
    expect(relays().filter((relay) => relay.isLeader)).toHaveLength(1);

    const leaderIndex = relays().findIndex((relay) => relay.isLeader);
    const [leader] = apps.splice(leaderIndex, 1);
    await leader.close();

    const survivor = apps[0];
    await waitFor(() => survivor.get(OutboxRelay).isLeader);

    const programId = await seedProgram();
    const id = (await reserve(survivor, programId)).json().id;
    const [message] = await collect((m) => m.value.data?.id === id, 1);
    expect(message.key).toBe(programId);
  });
});