import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';
import type { Env } from '../config/env.js';
import { Periodic } from '../shared/time/periodic.js';
import type { CleanupResult } from './operations.types.js';

const BATCH = 1000;

@Injectable()
export class MaintenanceCleanup implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger('MaintenanceCleanup');
  private readonly pool?: pg.Pool;
  private readonly interval: number;
  private readonly outboxRetentionSeconds: number;
  private readonly periodic = new Periodic(
    () => this.run(),
    (error) => this.logger.error(error),
  );

  constructor(config: ConfigService<Env, true>) {
    const url = config.get('MAINTENANCE_DATABASE_URL', { infer: true });
    this.pool = url ? new pg.Pool({ connectionString: url, max: 1 }) : undefined;
    this.interval = config.get('CLEANUP_INTERVAL_MS', { infer: true });
    this.outboxRetentionSeconds = config.get('OUTBOX_RETENTION_SECONDS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (!this.pool) {
      this.logger.warn('MAINTENANCE_DATABASE_URL is not set: published outbox events and expired idempotency records are kept');
      return;
    }
    this.periodic.start(this.interval);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.periodic.stop();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool?.end();
  }

  async run(): Promise<CleanupResult> {
    if (!this.pool) return { outboxEvents: 0, idempotencyRecords: 0 };
    const outboxEvents = await this.drain(
      `DELETE FROM outbox_event WHERE id IN (
         SELECT id FROM outbox_event
         WHERE published_at < now() - make_interval(secs => $1::double precision)
         LIMIT ${BATCH})`,
      [this.outboxRetentionSeconds],
    );
    const idempotencyRecords = await this.drain(
      `DELETE FROM idempotency_record WHERE (client_id, key) IN (
         SELECT client_id, key FROM idempotency_record WHERE expires_at < now() LIMIT ${BATCH})`,
      [],
    );
    if (outboxEvents + idempotencyRecords > 0) {
      this.logger.log(`Removed ${outboxEvents} published outbox events and ${idempotencyRecords} expired idempotency records`);
    }
    return { outboxEvents, idempotencyRecords };
  }

  private async drain(sql: string, params: unknown[]): Promise<number> {
    let total = 0;
    for (;;) {
      const { rowCount } = await this.pool!.query(sql, params);
      total += rowCount ?? 0;
      if ((rowCount ?? 0) < BATCH) return total;
    }
  }
}