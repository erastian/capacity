import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Gauge } from 'prom-client';
import type { Env } from '../config/env.js';
import { MetricsServer } from '../metrics/metrics.server.js';
import { PrismaService } from '../shared/db/prisma.service.js';
import { businessDate, Clock } from '../shared/time/clock.js';
import { Periodic } from '../shared/time/periodic.js';
import type {
  AgedParkedMessage,
  MonitorSnapshot,
  OverdueReservation,
  StalledOutbox,
  StaleProgram,
} from './operations.types.js';

@Injectable()
export class OperationalMonitors implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Monitors');
  private readonly timeZone: string;
  private readonly parkedMaxAgeSeconds: number;
  private readonly treasuryMaxAgeSeconds: number;
  private readonly interval: number;
  private readonly overdueGauge: Gauge;
  private readonly agedParkedGauge: Gauge;
  private readonly staleGauge: Gauge;
  private readonly outboxLagGauge: Gauge;
  private readonly outboxMaxLagSeconds: number;
  private readonly known = new Map<string, Set<string>>();
  private readonly periodic = new Periodic(
    () => this.check(),
    (error) => this.logger.error(error),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    metrics: MetricsServer,
    config: ConfigService<Env, true>,
  ) {
    this.timeZone = config.get('BUSINESS_TIMEZONE', { infer: true });
    this.parkedMaxAgeSeconds = config.get('PARKED_MAX_AGE_SECONDS', { infer: true });
    this.treasuryMaxAgeSeconds = config.get('TREASURY_DATA_MAX_AGE_SECONDS', { infer: true });
    this.interval = config.get('MONITOR_INTERVAL_MS', { infer: true });
    this.outboxMaxLagSeconds = config.get('OUTBOX_MAX_LAG_SECONDS', { infer: true });
    const registers = [metrics.registry];
    this.overdueGauge = new Gauge({
      name: 'capacity_reservations_overdue',
      help: 'Open reservations past their due date; unfunded ones leak limit, funded ones are buyer arrears',
      labelNames: ['funded'],
      registers,
    });
    this.agedParkedGauge = new Gauge({
      name: 'capacity_parked_messages_aged',
      help: 'Parked treasury messages older than PARKED_MAX_AGE',
      registers,
    });
    this.staleGauge = new Gauge({
      name: 'capacity_programs_treasury_stale',
      help: 'Programmes whose treasury data is older than TREASURY_DATA_MAX_AGE',
      registers,
    });
    this.outboxLagGauge = new Gauge({
      name: 'capacity_outbox_oldest_unpublished_seconds',
      help: 'Age of the oldest outbox event not yet published to Kafka',
      registers,
    });
  }

  onApplicationBootstrap(): void {
    this.periodic.start(this.interval);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.periodic.stop();
  }

  async check(): Promise<MonitorSnapshot> {
    const now = this.clock.now();
    const [overdue, agedParked, staleTreasury, oldestUnpublished] = await Promise.all([
      this.overdue(businessDate(now, this.timeZone)),
      this.agedParked(now),
      this.staleTreasury(now),
      this.oldestUnpublished(),
    ]);
    const outboxLagSeconds = oldestUnpublished
      ? Math.max(0, (now.getTime() - oldestUnpublished.createdAt.getTime()) / 1000)
      : 0;
    const stalled = oldestUnpublished && outboxLagSeconds > this.outboxMaxLagSeconds ? [oldestUnpublished] : [];

    this.overdueGauge.set({ funded: 'true' }, overdue.filter((item) => item.funded).length);
    this.overdueGauge.set({ funded: 'false' }, overdue.filter((item) => !item.funded).length);
    this.agedParkedGauge.set(agedParked.length);
    this.staleGauge.set(staleTreasury.length);
    this.outboxLagGauge.set(outboxLagSeconds);

    this.track('RESERVATION_OVERDUE', overdue, (item) => item.reservationId, (item) =>
      `reservation ${item.reservationId} (invoice ${item.invoiceId}, program ${item.programId}) is past due ${item.dueDate}, ${
        item.funded ? 'funded: buyer arrears' : 'unfunded: limit leak'
      }`,
    );
    this.track('PARKED_MESSAGE_AGED', agedParked, (item) => item.messageId, (item) =>
      `message ${item.messageId} of program ${item.programId} waits for ${item.awaitingKind} ${item.awaitingRef} since ${item.parkedAt.toISOString()}`,
    );
    this.track('TREASURY_DATA_STALE', staleTreasury, (item) => item.programId, (item) =>
      `program ${item.programId} last confirmed by treasury at ${item.syncedAt?.toISOString() ?? 'never'}`,
    );
    this.track('OUTBOX_STALLED', stalled, () => 'outbox', (item) =>
      `event ${item.eventId} (${item.type}) is unpublished since ${item.createdAt.toISOString()}`,
    );

    return { overdue, agedParked, staleTreasury, outboxLagSeconds };
  }

  private track<T>(alert: string, items: T[], keyOf: (item: T) => string, describe: (item: T) => string): void {
    const previous = this.known.get(alert) ?? new Set<string>();
    const current = new Set(items.map(keyOf));
    for (const item of items) {
      if (!previous.has(keyOf(item))) this.logger.warn(`${alert}: ${describe(item)}`);
    }
    for (const key of previous) {
      if (!current.has(key)) this.logger.log(`${alert} cleared: ${key}`);
    }
    this.known.set(alert, current);
  }

  private async overdue(today: string): Promise<OverdueReservation[]> {
    const rows = await this.prisma.$queryRaw<
      { id: string; program_id: string; invoice_id: string; due_date: string; funded: boolean }[]
    >`
      SELECT r.id, p.external_id AS program_id, r.invoice_id, r.due_date::text AS due_date, r.funded_at IS NOT NULL AS funded
      FROM reservation r
      JOIN program p ON p.id = r.program_id
      WHERE r.status IN ('ACTIVE', 'PARTIALLY_RELEASED') AND r.due_date < ${today}::date
    `;
    return rows.map((row) => ({
      reservationId: row.id,
      programId: row.program_id,
      invoiceId: row.invoice_id,
      dueDate: row.due_date,
      funded: row.funded,
    }));
  }

  private async agedParked(now: Date): Promise<AgedParkedMessage[]> {
    const rows = await this.prisma.$queryRaw<
      { message_id: string; program_external_id: string; awaiting_kind: string; awaiting_ref: string; parked_at: Date }[]
    >`
      SELECT message_id, program_external_id, awaiting_kind::text AS awaiting_kind, awaiting_ref, parked_at
      FROM parked_message
      WHERE resolved_at IS NULL
        AND parked_at < ${now}::timestamptz - make_interval(secs => ${this.parkedMaxAgeSeconds}::double precision)
    `;
    return rows.map((row) => ({
      messageId: row.message_id,
      programId: row.program_external_id,
      awaitingKind: row.awaiting_kind,
      awaitingRef: row.awaiting_ref,
      parkedAt: row.parked_at,
    }));
  }

  private async staleTreasury(now: Date): Promise<StaleProgram[]> {
    const rows = await this.prisma.$queryRaw<{ external_id: string; treasury_synced_at: Date | null }[]>`
      SELECT external_id, treasury_synced_at
      FROM program
      WHERE NOT (status = 'CLOSED' AND reserved = 0)
        AND (treasury_synced_at IS NULL
             OR treasury_synced_at < ${now}::timestamptz - make_interval(secs => ${this.treasuryMaxAgeSeconds}::double precision))
    `;
    return rows.map((row) => ({ programId: row.external_id, syncedAt: row.treasury_synced_at }));
  }

  private async oldestUnpublished(): Promise<StalledOutbox | undefined> {
    const rows = await this.prisma.$queryRaw<{ event_id: string; type: string; created_at: Date }[]>`
      SELECT event_id::text, type::text, created_at FROM outbox_event
      WHERE published_at IS NULL
      ORDER BY id
      LIMIT 1
    `;
    return rows[0] && { eventId: rows[0].event_id, type: rows[0].type, createdAt: rows[0].created_at };
  }
}