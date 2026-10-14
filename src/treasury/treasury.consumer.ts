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
import { setTimeout } from 'node:timers/promises';
import type { Env } from '../config/env.js';
import { isTransient } from '../shared/db/sql-state.js';
import { kafkaConnection, Topic } from '../shared/kafka/kafka.options.js';
import { Periodic } from '../shared/time/periodic.js';
import type { RawMessage } from './adapter/envelope.types.js';
import { InboundMetrics } from './inbound.metrics.js';
import { InboundProcessor } from './inbound.processor.js';
import { givesUp } from './retry-policy.js';

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
  private readonly maxAttempts: number;
  private stream?: MessagesStream<string, string, string, string>;
  private readonly stopping = new AbortController();
  private loop?: Promise<void>;

  constructor(
    private readonly processor: InboundProcessor,
    private readonly metrics: InboundMetrics,
    config: ConfigService<Env, true>,
  ) {
    this.sweepInterval = config.get('PARKED_SWEEP_INTERVAL_MS', { infer: true });
    this.maxAttempts = config.get('INBOUND_MAX_ATTEMPTS', { infer: true });
    if (config.get('TREASURY_CONSUMER_ENABLED', { infer: true })) {
      this.consumer = new Consumer({
        ...kafkaConnection(config),
        groupId: config.get('TREASURY_CONSUMER_GROUP', { infer: true }),
        deserializers: stringDeserializers,
        autocommit: false,
        maxWaitTime: 500,
      });
      this.consumer.on('error', (error: Error) => {
        this.logger.error(`Consumer group error: ${error.message}`);
        this.stream?.destroy(error);
      });
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.consumer) return;
    await this.processor.resolveAllParked();
    this.sweep.start(this.sweepInterval);
    this.loop = this.run(this.consumer);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping.abort();
    await this.sweep.stop();
    await this.stream?.close();
    await this.loop;
    await this.consumer?.close();
  }

  private get stopped(): boolean {
    return this.stopping.signal.aborted;
  }

  private async pause(ms: number): Promise<void> {
    await setTimeout(ms, undefined, { signal: this.stopping.signal }).catch(() => undefined);
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
        if (this.stopped) break;
        this.metrics.consuming(true);
        this.logger.log(`Consuming ${TOPICS.join(', ')}`);
        for await (const message of this.stream) {
          failures = 0;
          if (!(await this.handle(toRaw(message)))) break;
          await message.commit();
        }
      } catch (error) {
        if (!this.stopped) this.logger.error(`Consumer stopped: ${(error as Error).message}`);
      }
      this.metrics.consuming(false);
      await this.stream?.close().catch(() => undefined);
      if (this.stopped) return;
      const delay = backoff(failures++);
      this.logger.warn(`Restarting the consumer in ${delay}ms`);
      await this.pause(delay);
    }
  }

  private async handle(raw: RawMessage): Promise<boolean> {
    for (let attempt = 1; !this.stopped; attempt++) {
      try {
        await this.processor.process(raw);
        return true;
      } catch (error) {
        this.metrics.failed(isTransient(error));
        if (givesUp(error, attempt, this.maxAttempts)) {
          try {
            await this.processor.rejectPoison(raw, error as Error);
            return true;
          } catch (cause) {
            this.logger.error(`Poison message not recorded: ${(cause as Error).message}`);
          }
        }
        const delay = backoff(attempt - 1);
        this.logger.error(`Processing failed, retrying in ${delay}ms: ${(error as Error).message}`);
        await this.pause(delay);
      }
    }
    return false;
  }
}