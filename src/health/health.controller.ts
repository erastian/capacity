import { Controller, Get, HttpStatus } from '@nestjs/common';
import { setTimeout } from 'node:timers/promises';
import { Public } from '../shared/auth/decorators.js';
import { PrismaService } from '../shared/db/prisma.service.js';
import { AppError } from '../shared/errors/app-error.js';

const READINESS_TIMEOUT_MS = 2000;

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const timeout = new AbortController();
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        setTimeout(READINESS_TIMEOUT_MS, undefined, { signal: timeout.signal }).then(() => {
          throw new Error('timed out');
        }),
      ]);
    } catch {
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'NOT_READY', {
        detail: 'Database is unavailable',
      });
    } finally {
      timeout.abort();
    }
    return { status: 'ok' };
  }
}
