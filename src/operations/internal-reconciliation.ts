import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Gauge } from 'prom-client';
import type { Env } from '../config/env.js';
import { MetricsServer } from '../metrics/metrics.server.js';
import { PrismaService } from '../shared/db/prisma.service.js';
import { Clock } from '../shared/time/clock.js';
import { Periodic } from '../shared/time/periodic.js';
import type {
  CheckResult,
  DirtyReservationRow,
  LedgerChainRow,
  Mismatch,
  ProgramTotalsRow,
  ReconciliationReport,
} from './operations.types.js';

const SAMPLE_PER_CHECK = 100;
const PROGRAM_BATCH = 500;
const LEDGER_BATCH = 5000;
const RESERVATION_BATCH = 1000;
const MIN_SETTLE_MS = 5 * 60 * 1000;

const LEDGER_CHAIN = 'LEDGER_CHAIN';
const RESERVATIONS = 'RESERVATIONS';
const FULL_SWEEP = 'FULL_SWEEP';
const DAY_MS = 24 * 60 * 60 * 1000;

class Collector {
  private readonly results = new Map<string, CheckResult>();

  constructor(checks: string[]) {
    for (const check of checks) this.results.set(check, { check, count: 0, sample: [] });
  }

  add(mismatch: Mismatch): void {
    const result = this.results.get(mismatch.check)!;
    result.count += 1;
    if (result.sample.length < SAMPLE_PER_CHECK) result.sample.push(mismatch);
  }

  count(check: string): number {
    return this.results.get(check)!.count;
  }

  all(): CheckResult[] {
    return [...this.results.values()];
  }
}

@Injectable()
export class InternalReconciliation implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('InternalReconciliation');
  private readonly interval: number;
  private readonly settleMs: number;
  private readonly fullSweepMs: number;
  private readonly mismatchGauge: Gauge;
  private readonly periodic = new Periodic(
    () => this.run(),
    (error) => this.logger.error(error),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    metrics: MetricsServer,
    config: ConfigService<Env, true>,
  ) {
    this.interval = config.get('INTERNAL_RECONCILIATION_INTERVAL_MS', { infer: true });
    this.settleMs = Math.max(MIN_SETTLE_MS, 2 * config.get('DB_TX_TIMEOUT_MS', { infer: true }));
    this.fullSweepMs = config.get('INTERNAL_RECONCILIATION_FULL_SWEEP_DAYS', { infer: true }) * DAY_MS;
    this.mismatchGauge = new Gauge({
      name: 'capacity_internal_reconciliation_mismatches',
      help: 'Totals that disagree with their details at the last internal reconciliation, by check',
      labelNames: ['check'],
      registers: [metrics.registry],
    });
  }

  onApplicationBootstrap(): void {
    this.periodic.start(this.interval);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.periodic.stop();
  }

  async run(): Promise<ReconciliationReport> {
    const startedAt = this.clock.now();
    const found = new Collector([
      'PROGRAM_RESERVED',
      'PROGRAM_LEDGER',
      'OPEN_BLOCKING_BREAKS',
      LEDGER_CHAIN,
      'RESERVATION_RELEASES',
      'RESERVATION_FUNDING',
    ]);
    const checkpoints = await this.checkpoints();
    const lastFullSweep = new Date(checkpoints.get(FULL_SWEEP) ?? 0).getTime();
    const fullSweep = startedAt.getTime() - lastFullSweep >= this.fullSweepMs;

    await this.programTotals(found);
    const ledgerFrom = fullSweep ? 0n : BigInt(checkpoints.get(LEDGER_CHAIN) ?? '0');
    const verifiedLedgerId = await this.ledgerChain(ledgerFrom, found);
    const since = fullSweep
      ? new Date(0)
      : new Date(new Date(checkpoints.get(RESERVATIONS) ?? 0).getTime() - this.settleMs);
    await this.changedReservations(since, found);

    if (found.count(LEDGER_CHAIN) === 0) await this.saveCheckpoint(LEDGER_CHAIN, verifiedLedgerId.toString());
    if (found.count('RESERVATION_RELEASES') + found.count('RESERVATION_FUNDING') === 0) {
      await this.saveCheckpoint(RESERVATIONS, startedAt.toISOString());
    }
    if (fullSweep) await this.saveCheckpoint(FULL_SWEEP, startedAt.toISOString());

    for (const result of found.all()) {
      this.mismatchGauge.set({ check: result.check }, result.count);
      if (result.count > 0) {
        this.logger.error(
          `INTERNAL_RECONCILIATION_FAILED: ${result.check} has ${result.count} mismatches, first ${result.sample[0]!.subject}`,
        );
      }
    }
    const mismatches = found.all().flatMap((result) => result.sample);
    return { checkedAt: startedAt.toISOString(), ok: mismatches.length === 0, mismatches };
  }

  private async programTotals(found: Collector): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const rows: ProgramTotalsRow[] = await this.prisma.inTransaction(
        (tx) => tx.$queryRaw<ProgramTotalsRow[]>`
          SELECT p.external_id, p.reserved::text AS reserved, live.exposure::text AS live_exposure,
                 p.reserved <> live.exposure AS reserved_off,
                 concat_ws(' / ', p.credit_limit, p.external_utilized, p.reserved) AS balances,
                 concat_ws(' / ', coalesce(l.credit_limit_after, 0), coalesce(l.external_utilized_after, 0),
                           coalesce(l.reserved_after, 0)) AS ledger,
                 (coalesce(l.credit_limit_after, 0), coalesce(l.external_utilized_after, 0), coalesce(l.reserved_after, 0))
                   IS DISTINCT FROM (p.credit_limit, p.external_utilized, p.reserved) AS ledger_off,
                 p.open_blocking_breaks, open.counted::int AS counted_breaks
          FROM program p
          CROSS JOIN LATERAL (
            SELECT coalesce(sum(r.amount - r.released_amount), 0) AS exposure
            FROM reservation r
            WHERE r.program_id = p.id AND r.status IN ('ACTIVE', 'PARTIALLY_RELEASED')
          ) live
          LEFT JOIN LATERAL (
            SELECT credit_limit_after, external_utilized_after, reserved_after
            FROM capacity_ledger WHERE program_id = p.id ORDER BY id DESC LIMIT 1
          ) l ON true
          CROSS JOIN LATERAL (
            SELECT count(*) AS counted FROM program_break b
            WHERE b.program_id = p.id AND b.blocking AND b.resolved_at IS NULL
          ) open
          WHERE (${after}::text IS NULL OR p.external_id > ${after})
          ORDER BY p.external_id
          LIMIT ${PROGRAM_BATCH}
        `,
        { isolationLevel: 'RepeatableRead' },
      );
      for (const row of rows) {
        if (row.reserved_off) {
          found.add({ check: 'PROGRAM_RESERVED', subject: row.external_id, expected: row.live_exposure, actual: row.reserved });
        }
        if (row.ledger_off) {
          found.add({ check: 'PROGRAM_LEDGER', subject: row.external_id, expected: row.ledger, actual: row.balances });
        }
        if (row.counted_breaks !== row.open_blocking_breaks) {
          found.add({
            check: 'OPEN_BLOCKING_BREAKS',
            subject: row.external_id,
            expected: String(row.counted_breaks),
            actual: String(row.open_blocking_breaks),
          });
        }
      }
      if (rows.length < PROGRAM_BATCH) return;
      after = rows[rows.length - 1]!.external_id;
    }
  }

  private async ledgerChain(checkpoint: bigint, found: Collector): Promise<bigint> {
    let after = checkpoint;
    let firstMismatch: bigint | undefined;
    for (;;) {
      const rows = await this.prisma.$queryRaw<LedgerChainRow[]>`
        SELECT f.id::text AS id,
               concat_ws(' / ', coalesce(prev.credit_limit_after, 0) + f.credit_limit_delta,
                         coalesce(prev.external_utilized_after, 0) + f.external_utilized_delta,
                         coalesce(prev.reserved_after, 0) + f.reserved_delta) AS expected,
               concat_ws(' / ', f.credit_limit_after, f.external_utilized_after, f.reserved_after) AS actual,
               (coalesce(prev.credit_limit_after, 0) + f.credit_limit_delta,
                coalesce(prev.external_utilized_after, 0) + f.external_utilized_delta,
                coalesce(prev.reserved_after, 0) + f.reserved_delta)
                 IS DISTINCT FROM (f.credit_limit_after, f.external_utilized_after, f.reserved_after) AS off
        FROM capacity_ledger f
        LEFT JOIN LATERAL (
          SELECT credit_limit_after, external_utilized_after, reserved_after
          FROM capacity_ledger p WHERE p.program_id = f.program_id AND p.id < f.id
          ORDER BY p.id DESC LIMIT 1
        ) prev ON true
        WHERE f.id > ${after}::bigint
        ORDER BY f.id
        LIMIT ${LEDGER_BATCH}
      `;
      for (const row of rows) {
        if (!row.off) continue;
        firstMismatch ??= BigInt(row.id);
        found.add({ check: LEDGER_CHAIN, subject: row.id, expected: row.expected, actual: row.actual });
      }
      if (rows.length < LEDGER_BATCH) break;
      after = BigInt(rows[rows.length - 1]!.id);
    }

    const settled = await this.prisma.$queryRaw<{ id: string | null }[]>`
      SELECT max(id)::text AS id FROM capacity_ledger
      WHERE id > ${checkpoint}::bigint
        AND created_at < now() - make_interval(secs => ${this.settleMs / 1000}::double precision)
    `;
    const settledId = settled[0]?.id ? BigInt(settled[0].id) : checkpoint;
    return firstMismatch !== undefined && firstMismatch - 1n < settledId ? firstMismatch - 1n : settledId;
  }

  private async changedReservations(since: Date, found: Collector): Promise<void> {
    let after: { at: Date; id: string } | null = null;
    for (;;) {
      const rows: DirtyReservationRow[] = await this.prisma.inTransaction(
        (tx) => tx.$queryRaw<DirtyReservationRow[]>`
          SELECT r.id::text AS id, r.updated_at,
                 concat_ws(' / ', s.original, s.capacity) AS releases_expected,
                 concat_ws(' / ', r.released_original_amount, r.released_amount) AS releases_actual,
                 (s.original, s.capacity) IS DISTINCT FROM (r.released_original_amount, r.released_amount) AS releases_off,
                 coalesce(f.funding_ref, '-') AS funding_expected, coalesce(r.funding_ref, '-') AS funding_actual,
                 (f.funding_ref IS DISTINCT FROM r.funding_ref OR f.funded_at IS DISTINCT FROM r.funded_at) AS funding_off
          FROM reservation r
          CROSS JOIN LATERAL (
            SELECT coalesce(sum(CASE WHEN x.reason = 'REVERSAL' THEN -x.original_amount ELSE x.original_amount END), 0) AS original,
                   coalesce(sum(CASE WHEN x.reason = 'REVERSAL' THEN -x.amount ELSE x.amount END), 0) AS capacity
            FROM reservation_release x WHERE x.reservation_id = r.id
          ) s
          LEFT JOIN reservation_funding f ON f.reservation_id = r.id AND f.returned_at IS NULL
          WHERE r.updated_at >= ${since}::timestamptz
            AND (${after?.at ?? null}::timestamptz IS NULL
                 OR (r.updated_at, r.id) > (${after?.at ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY r.updated_at, r.id
          LIMIT ${RESERVATION_BATCH}
        `,
        { isolationLevel: 'RepeatableRead' },
      );
      for (const row of rows) {
        if (row.releases_off) {
          found.add({ check: 'RESERVATION_RELEASES', subject: row.id, expected: row.releases_expected, actual: row.releases_actual });
        }
        if (row.funding_off) {
          found.add({ check: 'RESERVATION_FUNDING', subject: row.id, expected: row.funding_expected, actual: row.funding_actual });
        }
      }
      if (rows.length < RESERVATION_BATCH) return;
      const last = rows[rows.length - 1]!;
      after = { at: last.updated_at, id: last.id };
    }
  }

  private async checkpoints(): Promise<Map<string, string>> {
    const rows = await this.prisma.$queryRaw<{ check: string; watermark: string }[]>`
      SELECT "check", watermark FROM reconciliation_checkpoint
    `;
    return new Map(rows.map((row) => [row.check, row.watermark]));
  }

  private async saveCheckpoint(check: string, watermark: string): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO reconciliation_checkpoint ("check", watermark, updated_at) VALUES (${check}, ${watermark}, now())
      ON CONFLICT ("check") DO UPDATE SET watermark = EXCLUDED.watermark, updated_at = EXCLUDED.updated_at
    `;
  }
}