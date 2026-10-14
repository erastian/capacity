import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module.js';
import { DeadLetterPublisher } from './dead-letter.js';
import { InboundMetrics } from './inbound.metrics.js';
import { InboundProcessor } from './inbound.processor.js';
import { BatchRepository } from './persistence/batch.repository.js';
import { BreakRepository } from './persistence/break.repository.js';
import { InboxRepository } from './persistence/inbox.repository.js';
import { ProgramStateRepository } from './persistence/program.repository.js';
import { QuoteRepository } from './persistence/quote.repository.js';
import { SettlementRepository } from './persistence/settlement.repository.js';
import { ReconciliationBatches } from './reconciliation-batches.js';
import { TreasuryConsumer } from './treasury.consumer.js';

@Module({
  imports: [OutboxModule],
  providers: [
    InboxRepository,
    ProgramStateRepository,
    SettlementRepository,
    BreakRepository,
    QuoteRepository,
    BatchRepository,
    InboundMetrics,
    DeadLetterPublisher,
    ReconciliationBatches,
    InboundProcessor,
    TreasuryConsumer,
  ],
  exports: [InboundProcessor, TreasuryConsumer],
})
export class TreasuryModule {}