import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import type { IncomingMessage } from 'node:http';
import { validateEnv, type Env } from './config/env.js';
import { HealthModule } from './health/health.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { AuditModule } from './audit/audit.module.js';
import { ProgramsModule } from './programs/programs.module.js';
import { RatesModule } from './rates/rates.module.js';
import { ReservationsModule } from './reservations/reservations.module.js';
import { TreasuryModule } from './treasury/treasury.module.js';
import { AuthModule } from './shared/auth/auth.module.js';
import { PrismaModule } from './shared/db/prisma.module.js';
import { TimeModule } from './shared/time/time.module.js';
import { ProblemFilter } from './shared/errors/problem.filter.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          genReqId: (req: IncomingMessage) =>
            (req as IncomingMessage & { id: string }).id,
          customAttributeKeys: { reqId: 'correlationId' },
          quietReqLogger: true,
          quietResLogger: true,
          autoLogging: {
            ignore: (req: IncomingMessage & { originalUrl?: string }) =>
              (req.originalUrl ?? req.url ?? '').startsWith('/health/'),
          },
          serializers: {
            req: (req: IncomingMessage) => ({
              method: req.method,
              url: req.url,
            }),
            res: (res: { statusCode: number }) => ({
              statusCode: res.statusCode,
            }),
          },
          customSuccessMessage: (req, res, responseTime) =>
            `${req.method} ${req.url} ${res.statusCode} ${responseTime}ms`,
          customErrorMessage: (req, res, error) =>
            `${req.method} ${req.url} ${res.statusCode} ${error.message}`,
          ...(config.get('NODE_ENV', { infer: true }) === 'development'
            ? {
                transport: {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    translateTime: 'SYS:HH:MM:ss.l',
                    ignore:
                      'pid,hostname,context,correlationId,req,res,responseTime',
                    messageFormat:
                      '{if context}[{context}] {end}{msg}{if correlationId} cid={correlationId}{end}',
                  },
                },
              }
            : {}),
        },
      }),
    }),
    PrismaModule,
    TimeModule,
    AuthModule,
    MetricsModule,
    HealthModule,
    ProgramsModule,
    ReservationsModule,
    RatesModule,
    AuditModule,
    OutboxModule,
    TreasuryModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
})
export class AppModule {}