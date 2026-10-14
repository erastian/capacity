import { Module } from '@nestjs/common';
import { EventPublisher } from './event-publisher.js';
import { KafkaEventPublisher } from './kafka-event-publisher.js';
import { OutboxRelay } from './outbox.relay.js';

@Module({
  providers: [{ provide: EventPublisher, useClass: KafkaEventPublisher }, OutboxRelay],
  exports: [OutboxRelay, EventPublisher],
})
export class OutboxModule {}
