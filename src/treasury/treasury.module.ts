import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module.js';
import { DeadLetterPublisher } from './dead-letter.js';
import { InboundMetrics } from './inbound.metrics.js';
import { InboundProcessor } from './inbound.processor.js';
import { InboundRepository } from './inbound.repository.js';
import { ReconciliationBatches } from './reconciliation-batches.js';
import { TreasuryConsumer } from './treasury.consumer.js';

@Module({
  imports: [OutboxModule],
  providers: [
    InboundRepository,
    InboundMetrics,
    DeadLetterPublisher,
    ReconciliationBatches,
    InboundProcessor,
    TreasuryConsumer,
  ],
  exports: [InboundProcessor],
})
export class TreasuryModule {}