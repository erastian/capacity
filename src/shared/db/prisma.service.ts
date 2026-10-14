import {
  HttpStatus,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Env } from '../../config/env.js';
import { AppError } from '../errors/app-error.js';

export type Tx = Prisma.TransactionClient;

const TRANSACTION_UNAVAILABLE = 'P2028';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly maxWait: number;
  private readonly timeout: number;

  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
        max: config.get('DB_POOL_SIZE', { infer: true }),
      }),
    });
    this.maxWait = config.get('DB_TX_MAX_WAIT_MS', { infer: true });
    this.timeout = config.get('DB_TX_TIMEOUT_MS', { infer: true });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
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
        error.code === TRANSACTION_UNAVAILABLE
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