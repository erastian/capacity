import { inject } from 'vitest';

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  METRICS_PORT: '0',
  DATABASE_URL: inject('databaseUrls').app,
});