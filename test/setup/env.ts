import { inject } from 'vitest';
import { AUDIENCE, ISSUER, JWKS_URL } from '../support/issuer.js';

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  METRICS_PORT: '0',
  DATABASE_URL: inject('databaseUrls').app,
  AUTH_ISSUER: ISSUER,
  AUTH_AUDIENCE: AUDIENCE,
  AUTH_JWKS_URL: JWKS_URL,
});