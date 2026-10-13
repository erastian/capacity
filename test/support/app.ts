import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../../src/app.factory.js';

export async function startApp(): Promise<NestFastifyApplication> {
  const app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}