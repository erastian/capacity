import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Consumer,
  type MessagesStream,
  MessagesStreamFallbackModes,
  MessagesStreamModes,
  stringDeserializers,
} from '@platformatic/kafka';
import type { Env } from '../config/env.js';
import { kafkaConnection, Topic } from '../shared/kafka/kafka.options.js';
import { InboundProcessor } from './inbound.processor.js';

const MAX_BACKOFF_MS = 30_000;

@Injectable()
export class TreasuryConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TreasuryConsumer.name);
  private readonly enabled: boolean;
  private readonly consumer?: Consumer<string, string, string, string>;
  private stream?: MessagesStream<string, string, string, string>;
  private loop?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly processor: InboundProcessor,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('TREASURY_CONSUMER_ENABLED', { infer: true });
    if (this.enabled) {
      this.consumer = new Consumer({
        ...kafkaConnection(config),
        groupId: config.get('TREASURY_CONSUMER_GROUP', { infer: true }),
        deserializers: stringDeserializers,
        autocommit: false,
        maxWaitTime: 500,
      });
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.consumer) return;
    await this.processor.resolveAllParked();
    const topics = [Topic.ProgramCapacity, Topic.FxRates];
    this.stream = await this.consumer.consume({
      topics,
      mode: MessagesStreamModes.COMMITTED,
      fallbackMode: MessagesStreamFallbackModes.EARLIEST,
    });
    this.loop = this.run(this.stream);
    this.logger.log(`Consuming ${topics.join(', ')}`);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    await this.stream?.close();
    await this.loop;
    await this.consumer?.close();
  }

  private async run(stream: MessagesStream<string, string, string, string>): Promise<void> {
    try {
      for await (const message of stream) {
        const processed = await this.processWithRetry(() =>
          this.processor.process({
            topic: message.topic,
            partition: message.partition,
            offset: message.offset,
            key: message.key ?? null,
            value: message.value ?? null,
            timestamp: new Date(Number(message.timestamp)),
          }),
        );
        if (!processed) return;
        await message.commit();
      }
    } catch (error) {
      if (!this.stopped) this.logger.error(error);
    }
  }

  private async processWithRetry(work: () => Promise<void>): Promise<boolean> {
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        await work();
        return true;
      } catch (error) {
        const delay = Math.min(250 * 2 ** attempt, MAX_BACKOFF_MS);
        this.logger.error(`Processing failed, retrying in ${delay}ms: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return false;
  }
}