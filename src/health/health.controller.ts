import { Controller, Get, HttpStatus } from '@nestjs/common';
import { Public } from '../shared/auth/decorators.js';
import { PrismaService } from '../shared/db/prisma.service.js';
import { AppError } from '../shared/errors/app-error.js';

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
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'NOT_READY', {
        detail: 'Database is unavailable',
      });
    }
    return { status: 'ok' };
  }
}