import type { DynamicModule, Type } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../../src/app.factory.js';
import { AppModule } from '../../src/app.module.js';

export async function startApp(
  module: Type | DynamicModule = AppModule,
): Promise<NestFastifyApplication> {
  const app = await createApp(module);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}