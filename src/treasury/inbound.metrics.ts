import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Counter, Gauge, Histogram } from 'prom-client';
import type { Env } from '../config/env.js';
import { MetricsServer } from '../metrics/metrics.server.js';
import type { Envelope } from './adapter/envelope.types.js';

@Injectable()
export class InboundMetrics {
  private readonly logger = new Logger('TreasuryInbound');
  private readonly clockSkewToleranceMs: number;
  private readonly consumerLagMaxMs: number;
  private readonly lag: Histogram;
  private readonly skew: Counter;
  private readonly outcomes: Counter;
  private readonly deadLetters: Counter;
  private readonly duplicates: Counter;
  private readonly alerts: Counter;
  private readonly snapshotBreaks: Counter;
  private readonly consumerUp: Gauge;
  private readonly failures: Counter;

  constructor(metrics: MetricsServer, config: ConfigService<Env, true>) {
    this.clockSkewToleranceMs = config.get('CLOCK_SKEW_TOLERANCE_SECONDS', { infer: true }) * 1000;
    this.consumerLagMaxMs = config.get('CONSUMER_LAG_MAX_SECONDS', { infer: true }) * 1000;
    const registers = [metrics.registry];
    this.lag = new Histogram({
      name: 'treasury_consumer_lag_seconds',
      help: 'Time between the broker append and the moment the message was read',
      labelNames: ['topic'],
      buckets: [0.05, 0.1, 0.5, 1, 5, 30, 60, 300, 1800, 3600],
      registers,
    });
    this.skew = new Counter({
      name: 'treasury_clock_skew_total',
      help: 'Messages whose asOf is ahead of the broker timestamp beyond tolerance',
      registers,
    });
    this.outcomes = new Counter({
      name: 'treasury_messages_total',
      help: 'Treasury messages by decision',
      labelNames: ['type', 'outcome'],
      registers,
    });
    this.deadLetters = new Counter({
      name: 'treasury_dead_letters_total',
      help: 'Treasury messages copied to the dead letter topic',
      labelNames: ['reason'],
      registers,
    });
    this.duplicates = new Counter({
      name: 'inbox_duplicate_total',
      help: 'Redelivered treasury messages answered from the inbox or the parked queue',
      labelNames: ['outcome'],
      registers,
    });
    this.alerts = new Counter({
      name: 'treasury_alerts_total',
      help: 'Operational alerts raised while processing treasury data',
      labelNames: ['alert'],
      registers,
    });
    this.snapshotBreaks = new Counter({
      name: 'treasury_snapshot_break_resolutions_total',
      help: 'Breaks listed in resolvedBreaks of a snapshot, by result',
      labelNames: ['result'],
      registers,
    });
    this.consumerUp = new Gauge({
      name: 'treasury_consumer_up',
      help: '1 while the treasury consumer has an open stream',
      registers,
    });
    this.failures = new Counter({
      name: 'treasury_processing_failures_total',
      help: 'Failed attempts to process a treasury message, live or parked',
      labelNames: ['transient'],
      registers,
    });
  }

  consuming(up: boolean): void {
    this.consumerUp.set(up ? 1 : 0);
  }

  failed(transient: boolean): void {
    this.failures.inc({ transient: String(transient) });
  }

  alert(alert: string, message: string): void {
    this.alerts.inc({ alert });
    this.logger.error(`${alert}: ${message}`);
  }

  warning(alert: string, message: string): void {
    this.alerts.inc({ alert });
    this.logger.warn(`${alert}: ${message}`);
  }

  snapshotBreak(result: string): void {
    this.snapshotBreaks.inc({ result });
  }

  received(topic: string, brokerTimestamp: Date, readAt: Date): void {
    const lagMs = readAt.getTime() - brokerTimestamp.getTime();
    this.lag.observe({ topic }, Math.max(lagMs, 0) / 1000);
    if (lagMs > this.consumerLagMaxMs) {
      this.logger.warn(`CONSUMER_LAG: ${topic} is ${Math.round(lagMs / 1000)}s behind`);
    }
  }

  checkClock(envelope: Envelope, brokerTimestamp: Date): void {
    const aheadMs = envelope.asOf.getTime() - brokerTimestamp.getTime();
    if (aheadMs > this.clockSkewToleranceMs) {
      this.skew.inc();
      this.logger.warn(
        `TREASURY_CLOCK_SKEW: message ${envelope.messageId} asOf is ${Math.round(aheadMs / 1000)}s ahead of the broker`,
      );
    }
  }

  decided(type: string, outcome: string): void {
    this.outcomes.inc({ type, outcome });
  }

  deadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
    this.logger.warn(`DLQ_MESSAGE: ${reason}`);
  }

  duplicate(outcome: string): void {
    this.duplicates.inc({ outcome });
  }
}