import type { DynamicModule, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import type { IncomingMessage } from 'node:http';
import { AppModule } from './app.module.js';
import { createValidationPipe } from './shared/errors/validation.js';
import { CORRELATION_HEADER, resolveCorrelationId } from './shared/http/correlation-id.js';

export function createAdapter(): FastifyAdapter {
  return new FastifyAdapter({
    requestIdHeader: false,
    genReqId: (req: IncomingMessage) => {
      const id = resolveCorrelationId(req.headers);
      (req as IncomingMessage & { id: string }).id = id;
      return id;
    },
  });
}

export function configureApp(app: NestFastifyApplication): NestFastifyApplication {
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(createValidationPipe());
  app.enableShutdownHooks();
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (request, reply) => {
      reply.header(CORRELATION_HEADER, request.id);
    });
  return app;
}

export async function createApp(module: Type | DynamicModule = AppModule): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(module, createAdapter(), { bufferLogs: true });
  return configureApp(app);
}
