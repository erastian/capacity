import {
  HttpStatus,
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Env } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';
import { boundedConnection } from './pg-options.js';

export type Tx = Prisma.TransactionClient;

const TRANSACTION_UNAVAILABLE = 'P2028';
const START_TIMED_OUT = 'Unable to start a transaction in the given time';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly maxWait: number;
  private readonly timeout: number;

  constructor(config: ConfigService<Env, true>) {
    const maxWait = config.get('DB_TX_MAX_WAIT_MS', { infer: true });
    const timeout = config.get('DB_TX_TIMEOUT_MS', { infer: true });
    super({
      adapter: new PrismaPg({
        ...boundedConnection(config.get('DATABASE_URL', { infer: true }), timeout, maxWait),
        max: config.get('DB_POOL_SIZE', { infer: true }),
      }),
    });
    this.maxWait = maxWait;
    this.timeout = timeout;
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onApplicationShutdown() {
    await this.$disconnect();
  }

  async inTransaction<T>(
    work: (tx: Tx) => Promise<T>,
    options: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number } = {},
  ): Promise<T> {
    try {
      return await this.$transaction(work, {
        maxWait: this.maxWait,
        timeout: options.timeout ?? this.timeout,
        isolationLevel: options.isolationLevel,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === TRANSACTION_UNAVAILABLE &&
        error.message.includes(START_TIMED_OUT)
      ) {
        throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'BUSY', {
          detail: 'Database is busy, retry later',
          headers: { 'retry-after': '1' },
        });
      }
      throw error;
    }
  }
}