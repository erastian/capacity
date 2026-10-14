import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Env } from '../../config/env.js';
import { boundedConnection } from './pg-options.js';

export type Tx = Prisma.TransactionClient;

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
    return this.$transaction(work, {
      maxWait: this.maxWait,
      timeout: options.timeout ?? this.timeout,
      isolationLevel: options.isolationLevel,
    });
  }
}