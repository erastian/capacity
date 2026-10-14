import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Consumer,
  type Message,
  type MessagesStream,
  MessagesStreamFallbackModes,
  MessagesStreamModes,
  stringDeserializers,
} from '@platformatic/kafka';
import type { Env } from '../config/env.js';
import { isDataError } from '../shared/db/sql-state.js';
import { kafkaConnection, Topic } from '../shared/kafka/kafka.options.js';
import { Periodic } from '../shared/time/periodic.js';
import type { RawMessage } from './adapter/envelope.types.js';
import { InboundProcessor } from './inbound.processor.js';

const MAX_BACKOFF_MS = 30_000;
const TOPICS = [Topic.ProgramCapacity, Topic.FxRates];

const backoff = (attempt: number) => Math.min(250 * 2 ** attempt, MAX_BACKOFF_MS);

function toRaw(message: Message<string, string, string, string>): RawMessage {
  return {
    topic: message.topic,
    partition: message.partition,
    offset: message.offset,
    key: message.key ?? null,
    value: message.value ?? null,
    timestamp: new Date(Number(message.timestamp)),
  };
}

@Injectable()
export class TreasuryConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(TreasuryConsumer.name);
  private readonly consumer?: Consumer<string, string, string, string>;
  private readonly sweepInterval: number;
  private readonly sweep = new Periodic(
    () => this.processor.resolveAllParked(),
    (error) => this.logger.error(error),
  );
  private stream?: MessagesStream<string, string, string, string>;
  private loop?: Promise<void>;
  private consuming = false;
  private stopped = false;

  constructor(
    private readonly processor: InboundProcessor,
    config: ConfigService<Env, true>,
  ) {
    this.sweepInterval = config.get('PARKED_SWEEP_INTERVAL_MS', { infer: true });
    if (config.get('TREASURY_CONSUMER_ENABLED', { infer: true })) {
      this.consumer = new Consumer({
        ...kafkaConnection(config),
        groupId: config.get('TREASURY_CONSUMER_GROUP', { infer: true }),
        deserializers: stringDeserializers,
        autocommit: false,
        maxWaitTime: 500,
      });
    }
  }

  get ready(): boolean {
    return !this.consumer || this.consuming;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.consumer) return;
    await this.processor.resolveAllParked();
    this.sweep.start(this.sweepInterval);
    this.loop = this.run(this.consumer);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    await this.sweep.stop();
    await this.stream?.close();
    await this.loop;
    await this.consumer?.close();
  }

  private async run(consumer: Consumer<string, string, string, string>): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        this.stream = await consumer.consume({
          topics: TOPICS,
          mode: MessagesStreamModes.COMMITTED,
          fallbackMode: MessagesStreamFallbackModes.EARLIEST,
        });
        this.consuming = true;
        failures = 0;
        this.logger.log(`Consuming ${TOPICS.join(', ')}`);
        for await (const message of this.stream) {
          if (!(await this.handle(toRaw(message)))) return;
          await message.commit();
        }
      } catch (error) {
        if (this.stopped) return;
        this.logger.error(`Consumer stopped: ${(error as Error).message}`);
      }
      this.consuming = false;
      await this.stream?.close().catch(() => undefined);
      if (this.stopped) return;
      const delay = backoff(failures++);
      this.logger.warn(`Restarting the consumer in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private async handle(raw: RawMessage): Promise<boolean> {
    for (let attempt = 0; !this.stopped; attempt++) {
      try {
        await this.processor.process(raw);
        return true;
      } catch (error) {
        if (isDataError(error)) {
          await this.processor.rejectPoison(raw, error as Error);
          return true;
        }
        const delay = backoff(attempt);
        this.logger.error(`Processing failed, retrying in ${delay}ms: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return false;
  }
}