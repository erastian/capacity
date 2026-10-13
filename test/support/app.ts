import type { DynamicModule, Type } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { configureApp, createAdapter } from '../../src/app.factory.js';
import { AppModule } from '../../src/app.module.js';

export async function startApp(
  module: Type | DynamicModule = AppModule,
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<NestFastifyApplication> {
  const moduleRef = await override(Test.createTestingModule({ imports: [module] })).compile();
  const app = configureApp(
    moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(), { bufferLogs: true }),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}