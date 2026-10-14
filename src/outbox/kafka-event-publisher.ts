import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProduceAcks, Producer, stringSerializers } from '@platformatic/kafka';
import type { Env } from '../config/env.js';
import { kafkaConnection } from '../shared/kafka/kafka.options.js';
import { EventPublisher } from './event-publisher.js';
import type { OutgoingMessage } from './outbox.types.js';

@Injectable()
export class KafkaEventPublisher extends EventPublisher implements OnApplicationShutdown {
  private readonly producer: Producer<string, string, string, string>;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.producer = new Producer({
      ...kafkaConnection(config),
      idempotent: true,
      acks: ProduceAcks.ALL,
      retries: 5,
      serializers: stringSerializers,
    });
  }

  async publish(messages: OutgoingMessage[]): Promise<void> {
    await this.producer.send({ messages });
  }

  async close(): Promise<void> {
    await this.producer.close();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}