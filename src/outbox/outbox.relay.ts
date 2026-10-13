import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';
import type { Env } from '../config/env.js';
import { Topic } from '../shared/kafka/kafka.options.js';
import { EventPublisher } from './event-publisher.js';
import type { OutboxRow, OutgoingMessage } from './outbox.types.js';

const LEADER_LOCK = 'capacity:outbox-relay';

export function topicFor(type: string): string {
  return type === 'INBOUND_MESSAGE_STATUS' ? Topic.MessageStatus : Topic.ReservationEvents;
}

export function toMessage(row: OutboxRow): OutgoingMessage {
  const correlationId = row.payload['correlationId'];
  return {
    topic: topicFor(row.type),
    key: row.partition_key,
    value: JSON.stringify({ eventId: row.event_id, ...row.payload }),
    headers: {
      'event-id': row.event_id,
      'event-type': row.type,
      ...(typeof correlationId === 'string' ? { 'correlation-id': correlationId } : {}),
    },
  };
}

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly enabled: boolean;
  private readonly databaseUrl: string;
  private readonly pollInterval: number;
  private readonly batchSize: number;
  private readonly leaderRetry: number;
  private connection?: pg.Client;
  private leader = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly publisher: EventPublisher,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('OUTBOX_RELAY_ENABLED', { infer: true });
    this.databaseUrl = config.get('DATABASE_URL', { infer: true });
    this.pollInterval = config.get('OUTBOX_POLL_INTERVAL_MS', { infer: true });
    this.batchSize = config.get('OUTBOX_BATCH_SIZE', { infer: true });
    this.leaderRetry = config.get('OUTBOX_LEADER_RETRY_MS', { infer: true });
  }

  get isLeader(): boolean {
    return this.leader;
  }

  onApplicationBootstrap(): void {
    if (this.enabled) this.schedule(0);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
    await this.dropConnection();
    await this.publisher.close();
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => {
        this.running = undefined;
      });
    }, delay);
  }

  private async tick(): Promise<void> {
    let next = this.pollInterval;
    try {
      if (!this.leader && !(await this.acquireLeadership())) {
        next = this.leaderRetry;
      } else {
        const published = await this.publishBatch();
        if (published === this.batchSize) next = 0;
      }
    } catch (error) {
      this.logger.error(error);
      await this.dropConnection();
      next = this.leaderRetry;
    }
    this.schedule(next);
  }

  private async acquireLeadership(): Promise<boolean> {
    const connection = new pg.Client({ connectionString: this.databaseUrl });
    connection.on('error', (error) => {
      this.logger.warn(`Leader connection lost: ${error.message}`);
      if (this.connection === connection) void this.dropConnection();
    });
    await connection.connect();
    const { rows } = await connection.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [LEADER_LOCK],
    );
    if (!rows[0]?.locked) {
      await connection.end();
      return false;
    }
    this.connection = connection;
    this.leader = true;
    this.logger.log('Outbox relay is the leader');
    return true;
  }

  private async publishBatch(): Promise<number> {
    const connection = this.connection;
    if (!connection || !this.leader) return 0;

    const { rows } = await connection.query<OutboxRow>(
      `SELECT id::text, event_id::text, type::text, partition_key, payload
       FROM outbox_event
       WHERE published_at IS NULL
       ORDER BY id
       LIMIT $1`,
      [this.batchSize],
    );
    if (rows.length === 0) return 0;

    await this.publisher.publish(rows.map(toMessage));
    await connection.query(
      'UPDATE outbox_event SET published_at = now() WHERE id = ANY($1::bigint[])',
      [rows.map((row) => row.id)],
    );
    this.logger.debug(`Published ${rows.length} outbox events`);
    return rows.length;
  }

  private async dropConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (this.leader) this.logger.warn('Outbox relay gave up leadership');
    this.leader = false;
    await connection?.end().catch(() => undefined);
  }
}