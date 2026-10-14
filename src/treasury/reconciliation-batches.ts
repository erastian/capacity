import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService } from '../shared/db/prisma.service.js';
import { Periodic } from '../shared/time/periodic.js';
import { InboundMetrics } from './inbound.metrics.js';
import { InboundRepository } from './inbound.repository.js';

@Injectable()
export class ReconciliationBatches implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReconciliationBatches.name);
  private readonly checkInterval: number;
  private readonly deadlines = new Periodic(
    () => this.checkDeadlines(),
    (error) => this.logger.error(error),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: InboundRepository,
    private readonly metrics: InboundMetrics,
    config: ConfigService<Env, true>,
  ) {
    this.checkInterval = config.get('RECONCILIATION_BATCH_CHECK_INTERVAL_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    this.deadlines.start(this.checkInterval);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.deadlines.stop();
  }

  async complete(batchId: string): Promise<void> {
    const completed = await this.prisma.inTransaction((tx) => this.repository.completeBatch(tx, batchId));
    if (!completed) return;
    if (completed.alertedAt) {
      this.logger.warn(`Reconciliation batch ${batchId} completed late: ${completed.received} of ${completed.programCount}`);
    } else {
      this.logger.log(`Reconciliation batch ${batchId} completed: ${completed.received} of ${completed.programCount}`);
    }
  }

  async checkDeadlines(): Promise<void> {
    const overdue = await this.prisma.inTransaction((tx) => this.repository.flagOverdueBatches(tx));
    for (const batch of overdue) {
      this.metrics.alert(
        'RECONCILIATION_BATCH_INCOMPLETE',
        `batch ${batch.batchId} has ${batch.received} of ${batch.programCount} snapshots past its deadline`,
      );
    }
  }
}