import { Controller, Get, HttpStatus } from '@nestjs/common';
import { Public } from '../shared/auth/decorators.js';
import { PrismaService } from '../shared/db/prisma.service.js';
import { AppError } from '../shared/errors/app-error.js';
import { TreasuryConsumer } from '../treasury/treasury.consumer.js';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consumer: TreasuryConsumer,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'NOT_READY', {
        detail: 'Database is unavailable',
      });
    }
    if (!this.consumer.ready) {
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'NOT_READY', {
        detail: 'Treasury consumer is not consuming',
      });
    }
    return { status: 'ok' };
  }
}