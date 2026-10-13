import { Injectable } from '@nestjs/common';
import { EventPublisher } from '../outbox/event-publisher.js';
import { Topic } from '../shared/kafka/kafka.options.js';
import type { RawMessage } from './adapter/envelope.types.js';

@Injectable()
export class DeadLetterPublisher {
  constructor(private readonly publisher: EventPublisher) {}

  async send(raw: RawMessage, reason: string): Promise<void> {
    await this.publisher.publish([
      {
        topic: Topic.DeadLetter,
        key: raw.key ?? `${raw.topic}:${raw.partition}:${raw.offset}`,
        value: raw.value ?? '',
        headers: {
          'dlq-reason': reason,
          'source-topic': raw.topic,
          'source-partition': String(raw.partition),
          'source-offset': raw.offset.toString(),
          'source-timestamp': raw.timestamp.toISOString(),
        },
      },
    ]);
  }
}