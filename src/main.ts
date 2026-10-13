import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createApp } from './app.factory.js';
import type { Env } from './config/env.js';

const app = await createApp();
const config = app.get<ConfigService<Env, true>>(ConfigService);
const port = config.get('PORT', { infer: true });
await app.listen(port, '0.0.0.0');
new Logger('Bootstrap').log(`API listening on :${port}`);