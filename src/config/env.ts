import { plainToInstance, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  IsTimeZone,
  IsUrl,
  Max,
  Min,
  validateSync,
} from 'class-validator';
import { BooleanFlag } from '../shared/validation/boolean-flag.js';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

export const SASL_MECHANISMS = [
  'PLAIN',
  'SCRAM-SHA-256',
  'SCRAM-SHA-512',
] as const;

export class Env {
  @IsIn(NODE_ENVS)
  NODE_ENV: (typeof NODE_ENVS)[number] = 'development';

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(65535)
  PORT = 3000;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(65535)
  METRICS_PORT = 9464;

  @IsIn(LOG_LEVELS)
  LOG_LEVEL: (typeof LOG_LEVELS)[number] = 'info';

  @IsString()
  DATABASE_URL: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  DB_POOL_SIZE = 10;

  @Type(() => Number)
  @IsInt()
  @Min(100)
  DB_TX_MAX_WAIT_MS = 5000;

  @Type(() => Number)
  @IsInt()
  @Min(100)
  DB_TX_TIMEOUT_MS = 10000;

  @IsTimeZone()
  BUSINESS_TIMEZONE = 'Europe/London';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  FX_RATE_MAX_AGE_SECONDS = 6 * 60 * 60;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  CLOCK_SKEW_TOLERANCE_SECONDS = 5 * 60;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  CONSUMER_LAG_MAX_SECONDS = 5 * 60;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  RECONCILIATION_BATCH_GRACE_SECONDS = 15 * 60;

  @Type(() => Number)
  @IsInt()
  @Min(1000)
  RECONCILIATION_BATCH_CHECK_INTERVAL_MS = 60_000;

  @BooleanFlag()
  PUBLISH_ACCEPTED_STATUS = false;

  @BooleanFlag()
  TREASURY_CONSUMER_ENABLED = true;

  @IsString()
  @IsNotEmpty()
  TREASURY_CONSUMER_GROUP = 'capacity-treasury';

  @IsString()
  @IsNotEmpty()
  KAFKA_BROKERS: string;

  @IsString()
  @IsNotEmpty()
  KAFKA_CLIENT_ID = 'capacity';

  @IsIn(SASL_MECHANISMS)
  KAFKA_SASL_MECHANISM: (typeof SASL_MECHANISMS)[number] = 'PLAIN';

  @IsString()
  @IsNotEmpty()
  KAFKA_SASL_USERNAME: string;

  @IsString()
  @IsNotEmpty()
  KAFKA_SASL_PASSWORD: string;

  @BooleanFlag()
  OUTBOX_RELAY_ENABLED = true;

  @Type(() => Number)
  @IsInt()
  @Min(10)
  OUTBOX_POLL_INTERVAL_MS = 500;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  OUTBOX_BATCH_SIZE = 100;

  @Type(() => Number)
  @IsInt()
  @Min(100)
  OUTBOX_LEADER_RETRY_MS = 5000;

  @IsUrl({ require_tld: false, require_protocol: true })
  AUTH_ISSUER: string;

  @IsString()
  @IsNotEmpty()
  AUTH_AUDIENCE: string;

  @IsUrl({ require_tld: false, require_protocol: true })
  AUTH_JWKS_URL: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(300)
  AUTH_CLOCK_TOLERANCE_SECONDS = 30;
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const env = plainToInstance(Env, raw);
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('; ');
    throw new Error(`Invalid environment: ${details}`);
  }
  return env;
}