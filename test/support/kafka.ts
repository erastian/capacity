import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

const IMAGE = 'apache/kafka:4.3.1';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePort(port));
    });
  });
}

export interface StartedKafka {
  container: StartedTestContainer;
  brokers: string;
  stop(): Promise<void>;
}

export const KAFKA_USERS = {
  capacity: { username: 'capacity', password: 'capacity-secret' },
  consumer: { username: 'consumer', password: 'consumer-secret' },
  treasury: { username: 'treasury', password: 'treasury-secret' },
} as const;

export async function startKafka(): Promise<StartedKafka> {
  const port = await freePort();
  const container = await new GenericContainer(IMAGE)
    .withExposedPorts({ container: 9092, host: port })
    .withEnvironment({
      CLUSTER_ID: 'capacity-test-kraft-0001',
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_LISTENERS: 'INTERNAL://:29092,EXTERNAL://:9092,CONTROLLER://localhost:9093',
      KAFKA_ADVERTISED_LISTENERS: `INTERNAL://localhost:29092,EXTERNAL://localhost:${port}`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,INTERNAL:SASL_PLAINTEXT,EXTERNAL:SASL_PLAINTEXT',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'INTERNAL',
      KAFKA_SASL_ENABLED_MECHANISMS: 'PLAIN',
      KAFKA_SASL_MECHANISM_INTER_BROKER_PROTOCOL: 'PLAIN',
      KAFKA_OPTS: '-Djava.security.auth.login.config=/etc/capacity-kafka/jaas.conf',
      KAFKA_AUTHORIZER_CLASS_NAME: 'org.apache.kafka.metadata.authorizer.StandardAuthorizer',
      KAFKA_SUPER_USERS: 'User:admin;User:ANONYMOUS',
      KAFKA_ALLOW_EVERYONE_IF_NO_ACL_FOUND: 'false',
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
    })
    .withCopyDirectoriesToContainer([
      { source: resolve('docker/kafka'), target: '/etc/capacity-kafka' },
    ])
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(120_000)
    .start();

  const init = await container.exec(['bash', '/etc/capacity-kafka/init.sh'], {
    env: { KAFKA_BOOTSTRAP: 'localhost:29092' },
  });
  if (init.exitCode !== 0) {
    throw new Error(`Kafka init failed: ${init.output}`);
  }

  return {
    container,
    brokers: `localhost:${port}`,
    stop: async () => {
      await container.stop();
    },
  };
}