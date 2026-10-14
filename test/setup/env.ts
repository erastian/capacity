import { inject } from 'vitest';
import { AUDIENCE, ISSUER, JWKS_URL } from '../support/issuer.js';

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  METRICS_PORT: '0',
  DATABASE_URL: inject('databaseUrls').app,
  DB_TX_MAX_WAIT_MS: '30000',
  MAINTENANCE_DATABASE_URL: inject('databaseUrls').maintenance,
  AUTH_ISSUER: ISSUER,
  AUTH_AUDIENCE: AUDIENCE,
  AUTH_JWKS_URL: JWKS_URL,
  KAFKA_BROKERS: 'localhost:1',
  KAFKA_SASL_USERNAME: 'capacity',
  KAFKA_SASL_PASSWORD: 'unused',
  OUTBOX_RELAY_ENABLED: 'false',
  TREASURY_CONSUMER_ENABLED: 'false',
});