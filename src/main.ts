import { Logger } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { createApp } from './app.factory.js';
import type { Env } from './config/env.js';
import { listenUrls } from './shared/http/listen-urls.js';

const app = await createApp();
const config = app.get<ConfigService<Env, true>>(ConfigService);
await app.listen(config.get('PORT', { infer: true }), '0.0.0.0');
const { port } = app.getHttpServer().address() as AddressInfo;
new Logger('Bootstrap').log(`API listening on ${listenUrls(port).join(', ')}`);